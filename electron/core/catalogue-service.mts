// The Hugging Face catalogue as the worker serves it (Task 5): the listing with its recommendation, a repository's
// variants, and the install that downloads, adds to the library and, when asked, activates. Everything the page sends
// is checked here (repository id, variant name) and the files to fetch always come from a fresh read of Hugging Face,
// never from the page. A chat template from a repository is untrusted Jinja: it is checked in its own thread with a time
// limit (ruling T1b), never on the worker's thread.
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import { HfError, isRepoId, modelVariants, searchModels, type CatalogueModel, type CatalogueSort, type ModelVariant } from './hf-catalogue.mts';
import { chooseVariant, codeQualityOf, fitOf, recommend, scoreModel, type Fit, type Recommendation, type RecommendationInput } from './model-score.mts';
import { ModelDownloads, type DownloadJob, type ModelDownloadsOptions } from './model-download.mts';
import { JsonStore } from './json-store.mts';
import type { HardwareInfo } from './hardware.mts';
import type { ToolSupport } from './model-capabilities.mts';
import type { GgufLibrary } from './gguf-library.mts';
import type { SettingsService } from './settings.mts';

/** A listing is read again from Hugging Face after an hour; until then the same query and sort answer from memory. */
export const CATALOGUE_TTL_MS = 3_600_000;
/** Only the first models of a listing get their file tree read (one request each), a few at a time. */
export const VARIANT_MODELS = 20;
export const VARIANT_CONCURRENCY = 4;
/** What a listing may take in all: under main's 30 s IPC cap. Past it, the requests still out are given up, the tool
 * checks still queued answer « unknown », and the listing is not kept, so the next one completes it. */
export const LIST_BUDGET_MS = 25_000;
/** One template's tool check (measured 2026-11-09: 30 ms to 6.2 s, once 23 s): past it, « unknown », kept. */
export const TOOL_CHECK_TIMEOUT_MS = 10_000;
const THREAD_START_TIMEOUT_MS = 30_000;
const TOOL_CACHE_LIMIT = 1000;
const LISTING_CACHE_LIMIT = 50;
/** The context a model is judged for when `local_context` is 'max' (spec: « Estimation tourne »). */
export const MAX_CONTEXT_TARGET = 32_768;
const SORTS: readonly CatalogueSort[] = ['downloads', 'likes', 'lastModified'];

export const REPO_REFUSED = 'Dépôt refusé.';
export const VARIANT_NOT_FOUND = 'Cette version du modèle est introuvable sur Hugging Face.';
const SORT_REFUSED = 'Tri du catalogue inconnu.';
const QUERY_REFUSED = 'Recherche du catalogue refusée.';
const GATED_SENTENCE = 'Accès restreint sur Hugging Face : ce modèle n\'est pas proposé en un clic, et sa taille n\'est pas connue.';
const NO_HASH_SENTENCE = 'Pas d\'empreinte SHA-256 publiée : pas d\'installation en un clic.';
const TOOL_THREAD = new URL('./tool-support-worker.mjs', import.meta.url);

export function hfUrlRefused(url: string): string {
  return `Adresse du catalogue Hugging Face refusée : ${url}`;
}

/** The test source of the catalogue (worker.mjs, workerData.hfBaseUrl, never passed by main.cjs): a loopback http URL
 * with a port, returned as its origin; anything else stops the worker at start. */
export function checkHfTestBaseUrl(value: unknown): string {
  let parsed: URL | null = null;
  try { parsed = typeof value === 'string' ? new URL(value) : null; } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(hfUrlRefused(String(value)));
  }
  return parsed.origin;
}

/** A repository id the page sent: hf-catalogue's own rule (no `.` or `..` segment), at most 200 characters. */
export function checkRepoId(repo: unknown): string {
  if (!isRepoId(repo) || repo.length > 200) throw new Error(REPO_REFUSED);
  return repo;
}

/** Where the catalogue downloads: the `models_dir` setting, or `<home>/models` when it is empty. */
export function modelsDirOf(config: Record<string, unknown>, home: string): string {
  const dir = config.models_dir;
  return typeof dir === 'string' && dir !== '' && isAbsolute(dir) ? dir : join(home, 'models');
}

/** The context a catalogue model is judged for: `local_context`, or MAX_CONTEXT_TARGET for 'max'. */
export function contextTargetOf(config: Record<string, unknown>): number {
  const value = config.local_context;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : MAX_CONTEXT_TARGET;
}

const TOOL_ANSWERS: readonly ToolSupport[] = ['yes', 'no', 'unknown'];

interface ToolThread { worker: Worker; ready: Promise<boolean> }

/**
 * toolSupportOf (core/model-capabilities.mts) in a thread of its own, one template at a time, each with a time limit:
 * too slow, stuck or failed is « unknown ». Answers are kept by template text (its SHA-256), so a template is checked
 * once per worker. A thread past its limit is ended with terminate(): it runs pure JavaScript (Jinja), no native call
 * (the 2026-10-24 lesson is about native work), and a loop that never ends can be stopped no other way.
 */
export class ToolSupportChecker {
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, ToolSupport>();
  private readonly pending = new Map<string, Promise<ToolSupport>>();
  private queue: Promise<unknown> = Promise.resolve();
  private thread: ToolThread | null = null;
  private closed = false;
  private sequence = 0;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? TOOL_CHECK_TIMEOUT_MS;
  }

  check(template: string | null | undefined): Promise<ToolSupport> {
    if (typeof template !== 'string' || template.trim() === '') return Promise.resolve('unknown');
    const key = createHash('sha256').update(template).digest('hex');
    const known = this.cache.get(key);
    if (known) return Promise.resolve(known);
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const run = this.queue.then(() => this.run(template)).then(result => {
      if (!this.closed) this.remember(key, result);
      return result;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, run);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Ends the thread; any check still waiting answers « unknown ». */
  async close(): Promise<void> {
    this.closed = true;
    const thread = this.thread;
    this.thread = null;
    if (thread) await thread.worker.terminate().catch(() => {});
  }

  private remember(key: string, result: ToolSupport): void {
    if (this.cache.size >= TOOL_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
  }

  private start(): ToolThread {
    if (this.thread) return this.thread;
    const worker = new Worker(TOOL_THREAD);
    worker.unref();
    worker.on('error', (error: Error) => { console.warn(`[catalogue] vérification des outils : ${error.message}`); });
    const ready = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), THREAD_START_TIMEOUT_MS);
      timer.unref();
      const onReady = (message: any) => {
        if (!message?.ready) return;
        clearTimeout(timer);
        worker.off('message', onReady);
        resolve(true);
      };
      worker.on('message', onReady);
      worker.once('exit', () => { clearTimeout(timer); resolve(false); });
    });
    const thread = { worker, ready };
    worker.once('exit', () => { if (this.thread === thread) this.thread = null; });
    this.thread = thread;
    return thread;
  }

  private stop(thread: ToolThread): void {
    if (this.thread === thread) this.thread = null;
    void thread.worker.terminate().catch(() => {});
  }

  private async run(template: string): Promise<ToolSupport> {
    if (this.closed) return 'unknown';
    const thread = this.start();
    if (!(await thread.ready)) {
      this.stop(thread);
      return 'unknown';
    }
    if (this.closed) return 'unknown';
    return new Promise(resolve => {
      const id = ++this.sequence;
      const finish = (result: ToolSupport, end: boolean) => {
        clearTimeout(timer);
        thread.worker.off('message', onMessage);
        thread.worker.off('exit', onExit);
        if (end) this.stop(thread);
        resolve(result);
      };
      const onMessage = (message: any) => {
        if (message?.id === id) finish(TOOL_ANSWERS.includes(message.result) ? message.result : 'unknown', false);
      };
      const onExit = () => finish('unknown', false);
      const timer = setTimeout(() => finish('unknown', true), this.timeoutMs);
      thread.worker.on('message', onMessage);
      thread.worker.on('exit', onExit);
      thread.worker.postMessage({ id, template });
    });
  }
}

export interface CatalogueView { recommendation: Recommendation; items: RecommendationInput[]; error: 'offline' | null }
/** A variant as the model's detail shows it: its estimated fit, and whether it can be installed in one click. */
export interface CatalogueVariant extends ModelVariant { fit: Fit; hashed: boolean }

export interface CatalogueDeps {
  baseUrl: string;
  token: () => Promise<string | undefined>;
  hardware: () => Promise<HardwareInfo>;
  contextSize: () => Promise<number>;
  toolSupport: (template: string | null) => Promise<ToolSupport>;
  now?: () => number;
  search?: typeof searchModels;
  variants?: typeof modelVariants;
}

const offlineView = (): CatalogueView => ({ recommendation: { kind: 'none', reason: 'offline' }, items: [], error: 'offline' });
const hashed = (variant: ModelVariant) => variant.files.length > 0 && variant.files.every(file => !!file.sha256);
const smallest = (variants: ModelVariant[]) => [...variants].sort((a, b) => a.totalBytes - b.totalBytes)[0];

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of `items` in the result. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function checkSort(sort: unknown): CatalogueSort {
  if (sort === undefined || sort === null) return 'downloads';
  if (!SORTS.includes(sort as CatalogueSort)) throw new Error(SORT_REFUSED);
  return sort as CatalogueSort;
}

function checkQuery(query: unknown): string {
  if (query === undefined || query === null) return '';
  if (typeof query !== 'string' || query.length > 200 || query.includes('\0')) throw new Error(QUERY_REFUSED);
  return query.trim();
}

export class CatalogueService {
  private readonly deps: CatalogueDeps;
  private readonly now: () => number;
  private readonly search: typeof searchModels;
  private readonly fetchVariants: typeof modelVariants;
  private readonly listings = new Map<string, { at: number; view: CatalogueView }>();

  constructor(deps: CatalogueDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.search = deps.search ?? searchModels;
    this.fetchVariants = deps.variants ?? modelVariants;
  }

  /** The recommendation and the listing for this query and sort, in Hugging Face's order. Hugging Face unreachable is
   * `error: 'offline'`, never a throw; the models installed stay usable (they are not read here). */
  async list(options: { query?: string; sort?: CatalogueSort } = {}): Promise<CatalogueView> {
    const query = checkQuery(options?.query);
    const sort = checkSort(options?.sort);
    const key = JSON.stringify([query, sort]);
    const kept = this.listings.get(key);
    if (kept && this.now() - kept.at < CATALOGUE_TTL_MS) return kept.view;

    const signal = AbortSignal.timeout(LIST_BUDGET_MS);
    const late = new Promise<null>(resolve => { signal.addEventListener('abort', () => resolve(null), { once: true }); });
    const machine = Promise.all([this.deps.hardware(), this.deps.contextSize()]);
    machine.catch(() => {});
    const { baseUrl } = this.deps;
    const token = await this.deps.token().catch(() => undefined);
    let models: CatalogueModel[];
    try {
      models = (await this.search({ query: query || undefined, sort, limit: VARIANT_MODELS, baseUrl, token, signal })).slice(0, VARIANT_MODELS);
    } catch (error) {
      if (error instanceof HfError || signal.aborted) return offlineView();
      throw error;
    }
    const [hardware, contextSize] = await machine;

    let complete = true;
    let unreachable = 0;
    const scored = await mapLimit(models, VARIANT_CONCURRENCY, async (model): Promise<RecommendationInput | null> => {
      const tools = Promise.race([this.deps.toolSupport(model.chatTemplate).catch((): ToolSupport => 'unknown'), late]);
      let variants: ModelVariant[] | null = null;
      let gated = false;
      try {
        variants = await this.fetchVariants(model.id, { baseUrl, token, signal });
      } catch (error) {
        // Restricted: listed, never in one click. Unreachable or cut by the budget: left out of this listing, which is
        // then not kept. A tree Hugging Face answers wrongly: left out.
        if (error instanceof HfError && error.kind === 'gated') gated = true;
        else if (signal.aborted || (error instanceof HfError && error.kind === 'offline')) { complete = false; unreachable++; }
        else if (!(error instanceof HfError)) throw error;
      }
      let support = await tools;
      if (support === null) { complete = false; support = 'unknown'; }
      const code = codeQualityOf(model);
      if (gated) {
        return { model: { ...model, gated: true }, variant: null, score: { ...scoreModel({ fit: 'none', tools: support, code }), sentence: GATED_SENTENCE } };
      }
      if (!variants || variants.length === 0) return null;
      const chosen = chooseVariant(variants, hardware, contextSize);
      const score = scoreModel({ fit: fitOf(chosen ?? smallest(variants), hardware, contextSize), tools: support, code });
      if (!chosen && score.fit !== 'none') score.sentence = `${score.sentence} ${NO_HASH_SENTENCE}`;
      return { model, variant: chosen, score };
    });
    if (models.length > 0 && unreachable === models.length) return offlineView();
    const items = scored.filter((item): item is RecommendationInput => item !== null);
    const view: CatalogueView = { recommendation: recommend(items), items, error: null };
    if (complete) this.keep(key, view);
    return view;
  }

  /** A repository's variants with their fit on this machine, and the one an install would take. */
  async variants(repo: unknown): Promise<{ variants: CatalogueVariant[]; chosen: string | null }> {
    const id = checkRepoId(repo);
    const machine = Promise.all([this.deps.hardware(), this.deps.contextSize()]);
    machine.catch(() => {});
    const variants = await this.fetchVariants(id, { baseUrl: this.deps.baseUrl, token: await this.deps.token().catch(() => undefined) });
    const [hardware, contextSize] = await machine;
    return {
      variants: variants.map(variant => ({ ...variant, fit: fitOf(variant, hardware, contextSize), hashed: hashed(variant) })),
      chosen: chooseVariant(variants, hardware, contextSize)?.name ?? null,
    };
  }

  /** The variant `name` of `repo` as Hugging Face lists it now: what an install downloads and verifies. */
  async variant(repo: unknown, name: unknown): Promise<ModelVariant> {
    const id = checkRepoId(repo);
    if (typeof name !== 'string' || name === '' || name.length > 500) throw new Error(VARIANT_NOT_FOUND);
    const variants = await this.fetchVariants(id, { baseUrl: this.deps.baseUrl, token: await this.deps.token().catch(() => undefined) });
    const found = variants.find(variant => variant.name === name);
    if (!found) throw new Error(VARIANT_NOT_FOUND);
    return found;
  }

  private keep(key: string, view: CatalogueView): void {
    const now = this.now();
    for (const [other, kept] of this.listings) if (now - kept.at >= CATALOGUE_TTL_MS) this.listings.delete(other);
    if (this.listings.size >= LISTING_CACHE_LIMIT) this.listings.delete(this.listings.keys().next().value!);
    this.listings.set(key, { at: now, view });
  }
}

const INTENTS_FILE = 'catalogue-installs.json';
const samePath = (path: string) => (process.platform === 'win32' ? resolvePath(path).toLowerCase() : resolvePath(path));
const isActive = (job: DownloadJob) => job.state === 'queued' || job.state === 'downloading' || job.state === 'verifying';
const intentKey = (repo: string, variantName: string, dir: string) => JSON.stringify([repo, variantName, samePath(dir)]);

export interface CatalogueInstallsOptions {
  home: string;
  library: GgufLibrary;
  settings: SettingsService;
  baseUrl?: string;
  token?: () => Promise<string | undefined>;
  onChange(job: DownloadJob): void;
  freeBytes?: ModelDownloadsOptions['freeBytes'];
}

/**
 * The catalogue's downloads (core/model-download.mts) and what follows one: the file joins the library and, when the
 * user asked « Installer et utiliser », becomes the active model. That wish is kept on disk beside the queue
 * (`<home>/catalogue-installs.json`), so a download resumed after a restart still ends active. The end step runs again
 * after a crash between it and the `done` line (Task 4): it reuses the library entry of the same path and sets the
 * same id, so running it twice changes nothing. The active model is read at each send (core/active-model.mts), so a
 * turn that is running keeps the model it started with.
 */
export class CatalogueInstalls {
  private readonly file: string;
  private readonly store = new JsonStore();
  private readonly library: GgufLibrary;
  private readonly settings: SettingsService;
  private readonly downloads: ModelDownloads;

  constructor(options: CatalogueInstallsOptions) {
    this.file = join(options.home, INTENTS_FILE);
    this.library = options.library;
    this.settings = options.settings;
    this.downloads = new ModelDownloads({
      home: options.home,
      baseUrl: options.baseUrl,
      token: options.token,
      freeBytes: options.freeBytes,
      onChange: job => {
        if (job.state === 'done' || job.state === 'cancelled' || job.state === 'error') void this.forget(intentKey(job.repo, job.variantName, job.dir));
        options.onChange(job);
      },
      onDone: job => this.finish(job),
    });
  }

  resume(): Promise<void> {
    return this.downloads.resume();
  }

  async install(repo: string, variant: ModelVariant, dir: string, activate: boolean): Promise<DownloadJob> {
    const key = intentKey(repo, variant.name, dir);
    if (activate) await this.mark(key, true);
    try {
      return await this.downloads.add(repo, variant, dir);
    } catch (error) {
      const stillRunning = this.downloads.list().some(job => isActive(job) && intentKey(job.repo, job.variantName, job.dir) === key);
      if (activate && !stillRunning) await this.forget(key);
      throw error;
    }
  }

  cancel(id: string): Promise<void> {
    return this.downloads.cancel(id);
  }

  list(): DownloadJob[] {
    return this.downloads.list();
  }

  close(): Promise<void> {
    return this.downloads.close();
  }

  private async finish(job: DownloadJob): Promise<void> {
    const path = job.finalPath;
    if (!path) throw new Error('fichier final inconnu');
    const known = (await this.library.list()).find(entry => samePath(entry.path) === samePath(path));
    const entry = known ?? await this.library.add(path, { sizeBytes: job.totalBytes });
    const wishes = await this.wishes();
    if (wishes.includes(intentKey(job.repo, job.variantName, job.dir))) await this.settings.saveGlobal({ active_local_model: entry.id });
  }

  private async wishes(): Promise<string[]> {
    const saved = await this.store.read<{ activate?: unknown }>(this.file, {}).catch(() => ({ activate: [] }));
    return Array.isArray(saved?.activate) ? saved.activate.filter((key): key is string => typeof key === 'string') : [];
  }

  private mark(key: string, on: boolean): Promise<unknown> {
    return this.store.update<{ activate?: unknown }>(this.file, {}, saved => {
      const keys = new Set(Array.isArray(saved?.activate) ? saved.activate.filter((k): k is string => typeof k === 'string') : []);
      if (on) keys.add(key); else keys.delete(key);
      return { activate: [...keys] };
    }, { backup: false });
  }

  private forget(key: string): Promise<void> {
    return this.mark(key, false).then(() => {}, error => { console.warn(`[catalogue] ${(error as Error).message}`); });
  }
}
