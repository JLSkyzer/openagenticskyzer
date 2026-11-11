// Downloads Hugging Face models one at a time, in the order they were asked for, and never lets an incomplete or
// corrupt file reach its final name. Each file is written to `<dir>/<name>.part`, resumed with a Range after a network
// cut or an app restart, hashed off this thread, and only when EVERY file of the variant matches its SHA-256 are they
// all renamed: a split model never appears half-installed. The queue lives in `<home>/model-downloads.json`, which also
// records which expected file each `.part` was started for (`parts`), so that a changed file restarts at zero.
// `baseUrl`, `freeBytes`, `writeChunk`, `retryDelaysMs` and `idleTimeoutMs` are seams for the tests.
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { freeBytes as diskFreeBytes, renameWithRetry } from './cuda-pack.mts';
import { HF_BASE_URL, mayCarryToken, safeModelFileName, type ModelVariant } from './hf-catalogue.mts';
import { JsonStore } from './json-store.mts';

export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface DownloadJob {
  id: string;
  repo: string;
  variantName: string;
  dir: string;
  files: ModelVariant['files'];
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  error: string | null;
  finalPath: string | null;
}

export const MODEL_DISK_MARGIN_BYTES = 1_073_741_824;

export const NOT_ENOUGH_DISK = "Espace disque insuffisant pour ce modèle : libère de la place puis relance le téléchargement.";
export const HASH_MISMATCH = "Le fichier téléchargé ne correspond pas à son empreinte SHA-256 : il a été supprimé et le modèle n'est pas installé.";
export const DISK_FULL = 'Le disque est plein : le téléchargement est arrêté. Libère de la place puis relance-le.';
export const MODELS_DIR_GONE = 'Le dossier des modèles de ce téléchargement est introuvable : rebranche le disque ou relance le téléchargement.';
export const NO_HASH = "Ce fichier n'a pas d'empreinte SHA-256 sur Hugging Face : il ne peut pas être vérifié, donc pas installé en un clic.";
export const FILE_EXISTS = 'Un autre fichier porte déjà ce nom dans le dossier des modèles : il a été laissé intact et rien n\'a été installé.';
export const FILE_BUSY = 'Un autre téléchargement en cours écrit déjà ce fichier.';
export const FILE_CHANGED = 'Ce fichier a changé sur Hugging Face depuis son affichage : relance le téléchargement depuis le catalogue.';
export const NETWORK_FAILED = 'Hugging Face est injoignable : le téléchargement est arrêté, et il reprendra où il en était si tu le relances.';
export const ACCESS_DENIED = "Accès refusé par Hugging Face : ce modèle est restreint.";
export const FILE_NOT_FOUND = 'Ce fichier est introuvable sur Hugging Face.';
export const URL_REFUSED = 'Adresse de téléchargement refusée.';
export const WRITE_REFUSED = "Écriture impossible dans le dossier des modèles : le fichier y est refusé ou tenu par un autre programme.";
export const DOWNLOAD_FAILED = 'Le téléchargement a échoué.';
const CLOSED = 'Le gestionnaire de téléchargements est fermé.';
const REPO_REFUSED = 'Dépôt refusé.';

const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 250;
const IDLE_TIMEOUT_MS = 60_000;
// Waits between two tries that received nothing (about 5 min in all): a short network cut must not end the download.
const RETRY_DELAYS_MS = [500, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000];
const USER_AGENT = 'openagent';
const STORE_FILE = 'model-downloads.json';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const WORKER_PATH = fileURLToPath(new URL('./sha256-file-worker.mjs', import.meta.url));

/** A failure with its final, French message: the job ends, no retry. */
class DownloadFailure extends Error {}
/** A failure of the network or the server: tried again from what is on disk. */
class Retryable extends Error {}

function abortError(): Error {
  return new DOMException('Calcul annulé.', 'AbortError');
}

/** The SHA-256 of a file, in lower-case hex, computed in a worker thread. On abort, rejects once the worker has ended. */
export function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const abort = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(WORKER_PATH, { workerData: { path, abort } });
    const onAbort = () => { Atomics.store(abort, 0, 1); };
    let digest: string | null = null;
    let failure: unknown = null;
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (value: string) => { digest = value; });
    worker.on('error', error => { failure = error; });
    worker.on('exit', () => {
      signal?.removeEventListener('abort', onAbort);
      if (digest !== null) resolve(digest);
      else if (signal?.aborted) reject(abortError());
      else reject(failure ?? new Error(DOWNLOAD_FAILED));
    });
  });
}

const isActive = (job: DownloadJob) => job.state === 'queued' || job.state === 'downloading' || job.state === 'verifying';
const clone = (job: DownloadJob): DownloadJob => structuredClone(job);
const samePath = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const totalOf = (files: DownloadJob['files']) => files.reduce((sum, file) => sum + file.size, 0);

function checkRepo(repo: unknown): void {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..')) {
    throw new DownloadFailure(REPO_REFUSED);
  }
}

/** What cannot be fetched into the models folder and verified is refused: an unsafe name, a bad size, no SHA-256. */
function checkFiles(files: unknown): asserts files is { path: string; size: number; sha256: string }[] {
  if (!Array.isArray(files) || files.length === 0) throw new DownloadFailure(DOWNLOAD_FAILED);
  const names = new Set<string>();
  for (const file of files) {
    let name: string;
    try { name = samePath(safeModelFileName(file?.path)); } catch (error) { throw new DownloadFailure((error as Error).message); }
    if (names.has(name)) throw new DownloadFailure('Nom de fichier refusé');
    names.add(name);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new DownloadFailure(DOWNLOAD_FAILED);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) throw new DownloadFailure(NO_HASH);
  }
}

function isStoredJob(value: any): value is DownloadJob {
  return !!value && typeof value.id === 'string' && typeof value.repo === 'string' && typeof value.variantName === 'string'
    && typeof value.dir === 'string' && Array.isArray(value.files) && typeof value.state === 'string';
}

function messageOf(error: unknown): string {
  if (error instanceof DownloadFailure) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return DISK_FULL;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENODEV' || code === 'EIO') return MODELS_DIR_GONE;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') return WRITE_REFUSED;
  console.warn(`[model-download] ${error instanceof Error ? error.message : String(error)}`);
  return DOWNLOAD_FAILED;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; } // follows a junction: a models folder may be one
}

async function sizeOnDisk(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** handle.write can write less than it was given. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let written = 0; written < chunk.length;) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten;
}

interface Target { url: URL; size: number; sha256: string; final: string; part: string; alreadyFinal: boolean }

interface Run {
  job: DownloadJob;
  control: AbortController;
  cancelled: boolean;
  committing: boolean;      // past this point nothing stops the job: the files are being put in place
  finished: Promise<void>;
  lastProgressAt: number;
  lastProgressBytes: number;
}

interface Stored { jobs: DownloadJob[]; parts: Record<string, string> }

export interface ModelDownloadsOptions {
  home: string;
  baseUrl?: string;
  token?: () => Promise<string | undefined>;
  onChange(job: DownloadJob): void;
  onDone(job: DownloadJob): Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
  writeChunk?: (handle: FileHandle, chunk: Uint8Array) => Promise<void>;
  retryDelaysMs?: readonly number[];
  idleTimeoutMs?: number;
}

export class ModelDownloads {
  private readonly file: string;
  private readonly store = new JsonStore();
  private readonly baseUrl: string;
  private readonly token: () => Promise<string | undefined>;
  private readonly onChange: (job: DownloadJob) => void;
  private readonly onDone: (job: DownloadJob) => Promise<void>;
  private readonly free: (dir: string) => Promise<number>;
  private readonly write: (handle: FileHandle, chunk: Uint8Array) => Promise<void>;
  private readonly retryDelays: readonly number[];
  private readonly idleTimeoutMs: number;
  private jobs: DownloadJob[] = [];
  private parts: Record<string, string> = {};   // .part path -> `size:sha256` of the file it was started for
  private ready: Promise<void> | null = null;
  private current: Run | null = null;
  private closed = false;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(options: ModelDownloadsOptions) {
    this.file = join(options.home, STORE_FILE);
    this.baseUrl = options.baseUrl ?? HF_BASE_URL;
    this.token = options.token ?? (async () => undefined);
    this.onChange = options.onChange;
    this.onDone = options.onDone;
    this.free = options.freeBytes ?? diskFreeBytes;
    this.write = options.writeChunk ?? writeAll;
    this.retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  /** Reloads the queue and starts what was pending. Idempotent; `add` goes through it too. */
  resume(): Promise<void> {
    return this.ready ??= this.load();
  }

  private async load(): Promise<void> {
    const stored = await this.store.read<Partial<Stored>>(this.file, {});
    const jobs = Array.isArray(stored.jobs) ? stored.jobs.filter(isStoredJob) : [];
    // A line that is over has nothing left to show after a restart. A job in error stays: it may hold a .part to clear.
    this.jobs = jobs.filter(job => job.state !== 'done' && job.state !== 'cancelled');
    this.parts = stored.parts && typeof stored.parts === 'object' ? stored.parts : {};
    for (const job of this.jobs) {
      if (!isActive(job)) continue;
      job.bytesPerSecond = null;
      if (await isDirectory(job.dir)) {
        job.state = 'queued';
      } else {
        job.state = 'error';
        job.error = MODELS_DIR_GONE;
        this.emit(job);
      }
    }
    await this.persist();
    this.pump();
  }

  async add(repo: string, variant: ModelVariant, dir: string): Promise<DownloadJob> {
    if (this.closed) throw new Error(CLOSED);
    checkRepo(repo);
    checkFiles(variant?.files);
    const files = variant.files.map(file => ({ ...file }));
    const folder = resolvePath(dir);
    await this.resume();
    if (this.closed) throw new Error(CLOSED);
    try { await mkdir(folder, { recursive: true }); } catch { throw new DownloadFailure(MODELS_DIR_GONE); }

    const same = this.jobs.find(job => isActive(job) && job.repo === repo && job.variantName === variant.name && samePath(job.dir) === samePath(folder));
    if (same) return clone(same);
    const names = new Set(files.map(file => samePath(safeModelFileName(file.path))));
    const overlaps = (job: DownloadJob) => samePath(job.dir) === samePath(folder) && job.files.some(file => {
      try { return names.has(samePath(safeModelFileName(file.path))); } catch { return false; }
    });
    if (this.jobs.some(job => isActive(job) && overlaps(job))) throw new Error(FILE_BUSY);

    // A finished or failed line for the same file is replaced: its .part now belongs to this job.
    this.jobs = this.jobs.filter(job => isActive(job) || !overlaps(job));
    const job: DownloadJob = {
      id: randomUUID(), repo, variantName: variant.name, dir: folder, files, state: 'queued',
      receivedBytes: 0, totalBytes: totalOf(files), bytesPerSecond: null, error: null, finalPath: null,
    };
    this.jobs.push(job);
    const added = clone(job);
    await this.persist();
    this.emit(job);
    this.pump();
    return added;
  }

  /** Ends a queued, running or failed job and removes its .part. Too late once its files are being put in place. */
  async cancel(id: string): Promise<void> {
    await this.resume();
    const job = this.jobs.find(j => j.id === id);
    if (!job) return;
    const run = this.current;
    if (run?.job === job) {
      if (run.committing) return;
      run.cancelled = true;
      run.control.abort();
      await run.finished;            // it may have ended by itself just before: then the state below is still 'error'
    }
    if (job.state === 'queued' || job.state === 'error') await this.markCancelled(job);
  }

  list(): DownloadJob[] {
    return this.jobs.map(clone);
  }

  /** Stops the running job as it is: its .part and its line stay for the next resume(). */
  async close(): Promise<void> {
    this.closed = true;
    const run = this.current;
    if (run && !run.committing) run.control.abort();
    await run?.finished;
    await this.ready?.catch(() => {});
    await this.saving;
  }

  private emit(job: DownloadJob): void {
    try { this.onChange(clone(job)); } catch (error) { console.warn(`[model-download] onChange: ${(error as Error).message}`); }
  }

  /** The file is rewritten whole with the latest state. A failure leaves the queue running from memory. */
  private persist(): Promise<void> {
    const saved = this.store
      .update<Stored>(this.file, { jobs: [], parts: {} }, () => ({ jobs: this.jobs, parts: this.parts }), { backup: false })
      .then(() => {}, error => { console.warn(`[model-download] ${(error as Error).message}`); });
    this.saving = saved;
    return saved;
  }

  private pump(): void {
    if (this.closed || this.current) return;
    const job = this.jobs.find(j => j.state === 'queued');
    if (!job) return;
    const run: Run = {
      job, control: new AbortController(), cancelled: false, committing: false, finished: Promise.resolve(),
      lastProgressAt: performance.now(), lastProgressBytes: 0,
    };
    this.current = run;
    run.finished = this.execute(run).finally(() => {
      this.current = null;
      this.pump();
    });
  }

  private async execute(run: Run): Promise<void> {
    try {
      const targets = await this.prepare(run);
      await this.fetchAll(run, targets);
      await this.verify(run, targets);
      await this.commit(run, targets);
    } catch (error) {
      await this.interrupted(run, error);
    }
  }

  private async interrupted(run: Run, error: unknown): Promise<void> {
    const { job } = run;
    job.bytesPerSecond = null;
    if (run.cancelled && !run.committing) {
      await this.markCancelled(job);
      return;
    }
    if (this.closed && !run.committing) {
      await this.persist();          // the line stays pending, for the next resume()
      return;
    }
    job.state = 'error';
    job.error = messageOf(error);
    this.emit(job);
    await this.persist();
  }

  private async markCancelled(job: DownloadJob): Promise<void> {
    job.state = 'cancelled';
    job.error = null;
    job.bytesPerSecond = null;
    for (const file of job.files) {
      let part: string;
      try { part = join(job.dir, safeModelFileName(file.path)) + '.part'; } catch { continue; }
      await rm(part, { force: true, maxRetries: 3 }).catch(() => {});
      delete this.parts[part];
    }
    this.emit(job);
    await this.persist();
  }

  /** Decides from the disk what each file still needs, then checks the space. No request goes out before this ends. */
  private async prepare(run: Run): Promise<Target[]> {
    const { job } = run;
    job.state = 'downloading';
    job.error = null;
    job.bytesPerSecond = null;
    job.finalPath = null;
    await this.persist();
    this.emit(job);

    checkRepo(job.repo);
    checkFiles(job.files);
    if (!(await isDirectory(job.dir))) throw new DownloadFailure(MODELS_DIR_GONE);

    const targets: Target[] = [];
    let held = 0;
    for (const file of job.files as { path: string; size: number; sha256: string }[]) {
      run.control.signal.throwIfAborted();
      const final = join(job.dir, safeModelFileName(file.path));
      const part = final + '.part';
      const target: Target = { url: this.urlOf(job.repo, file.path), size: file.size, sha256: file.sha256.toLowerCase(), final, part, alreadyFinal: false };
      targets.push(target);
      const existing = await stat(final).catch(() => null);
      if (existing) {
        // A file already there is ours only if its hash says so (verify()): the end of an interrupted install.
        if (!existing.isFile() || existing.size !== file.size) throw new DownloadFailure(FILE_EXISTS);
        target.alreadyFinal = true;
        held += file.size;
        continue;
      }
      const identity = `${file.size}:${target.sha256}`;
      if (this.parts[part] !== identity) {
        await rm(part, { force: true, maxRetries: 3 });
        this.parts[part] = identity;
      } else {
        const size = await sizeOnDisk(part);
        if (size > file.size) await rm(part, { force: true, maxRetries: 3 });
        else held += size;
      }
    }
    await this.persist();
    job.totalBytes = totalOf(job.files);
    job.receivedBytes = held;
    run.lastProgressBytes = held;
    if (held > 0) this.emit(job);

    // On a resume the bytes already on disk need no new room: asking for the whole model would strand a download
    // that was nearly finished on a disk it had itself filled.
    if ((await this.free(job.dir)) < job.totalBytes - held + MODEL_DISK_MARGIN_BYTES) throw new DownloadFailure(NOT_ENOUGH_DISK);
    run.control.signal.throwIfAborted();
    return targets;
  }

  private urlOf(repo: string, path: string): URL {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return this.checkedUrl(`${this.baseUrl}/${repo}/resolve/main/${encoded}`);
  }

  /** https only; plain http only to the loopback of the tests' base URL. */
  private checkedUrl(location: string, base?: URL): URL {
    let url: URL;
    try { url = new URL(location, base); } catch { throw new DownloadFailure(URL_REFUSED); }
    const seam = this.baseUrl !== HF_BASE_URL && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !seam) throw new DownloadFailure(URL_REFUSED);
    return url;
  }

  private async fetchAll(run: Run, targets: Target[]): Promise<void> {
    let before = 0;
    for (const target of targets) {
      run.control.signal.throwIfAborted();
      if (!target.alreadyFinal) await this.fetchWithRetries(run, target, before);
      before += target.size;
    }
  }

  private async fetchWithRetries(run: Run, target: Target, before: number): Promise<void> {
    const { signal } = run.control;
    for (let failures = 0; ;) {
      const start = await sizeOnDisk(target.part);
      if (start === target.size) return;
      try {
        await this.transfer(run, target, before, start);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Retryable)) throw error;
      }
      if (await sizeOnDisk(target.part) > start) failures = 0; // it moved: the next cut starts a new count
      if (failures >= this.retryDelays.length) throw new DownloadFailure(NETWORK_FAILED);
      run.job.bytesPerSecond = null;
      this.emit(run.job);
      await delay(this.retryDelays[failures++], undefined, { signal });
    }
  }

  /** One request, written after the `offset` bytes already on disk. Ends with exactly `target.size` bytes, or throws. */
  private async transfer(run: Run, target: Target, before: number, offset: number): Promise<void> {
    const idle = new AbortController();
    const signal = AbortSignal.any([run.control.signal, idle.signal]);
    let timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), this.idleTimeoutMs); };
    try {
      arm();
      const response = await this.follow(target.url, offset, signal);
      let position = await this.positionOf(response, target, offset);
      // 'a' never rewinds what is kept; 'w' empties the file when the server starts again from byte 0.
      const handle = await open(target.part, position > 0 ? 'a' : 'w');
      run.job.receivedBytes = before + position;
      try {
        const reader = response.body!.getReader();
        try {
          for (;;) {
            arm();
            let read: ReadableStreamReadResult<Uint8Array>;
            try { read = await reader.read(); } catch { throw new Retryable('coupure'); }
            clearTimeout(timer);     // the disk's own time does not count as idle
            if (read.done) break;
            if (position + read.value.length > target.size) throw new DownloadFailure(FILE_CHANGED);
            await this.write(handle, read.value);
            position += read.value.length;
            run.job.receivedBytes = before + position;
            this.progress(run);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } finally {
        await handle.close();
      }
      if (position !== target.size) throw new Retryable('réponse incomplète');
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET with redirects followed by hand. The token, once dropped for a foreign host, never comes back. */
  private async follow(start: URL, offset: number, signal: AbortSignal): Promise<Response> {
    let token = (await this.token().catch(() => undefined))?.trim() || undefined;
    let target = start;
    for (let redirects = 0; ; redirects++) {
      if (token && !mayCarryToken(target, this.baseUrl)) token = undefined;
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      let response: Response;
      try { response = await fetch(target, { headers, redirect: 'manual', signal }); } catch { throw new Retryable('injoignable'); }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || redirects >= MAX_REDIRECTS) throw new DownloadFailure(URL_REFUSED);
      target = this.checkedUrl(location, target);
    }
  }

  /** Where this answer's body starts in the file, or why it cannot be used. Consumes the body when it is refused. */
  private async positionOf(response: Response, target: Target, offset: number): Promise<number> {
    const refuse = async (error: Error): Promise<never> => {
      await response.body?.cancel().catch(() => {});
      throw error;
    };
    const { status } = response;
    if (status === 200 && response.body) {
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== target.size) return refuse(new DownloadFailure(FILE_CHANGED));
      return 0;                      // no Range asked, or a server that ignored it: restart at zero
    }
    if (status === 206 && response.body && offset > 0) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
      if (!range || Number(range[1]) !== offset) return refuse(new Retryable('plage inattendue'));
      if (range[2] !== '*' && Number(range[2]) !== target.size) return refuse(new DownloadFailure(FILE_CHANGED));
      return offset;
    }
    if (status === 401 || status === 403) return refuse(new DownloadFailure(ACCESS_DENIED));
    if (status === 404) return refuse(new DownloadFailure(FILE_NOT_FOUND));
    if (status === 416) {            // nothing to read after `offset` on the server: what we hold is not its file
      await rm(target.part, { force: true, maxRetries: 3 });
      return refuse(new Retryable('plage refusée'));
    }
    if (status === 200 || status === 206 || status === 408 || status === 429 || status >= 500) return refuse(new Retryable(`HTTP ${status}`));
    return refuse(new DownloadFailure(`Hugging Face a répondu HTTP ${status}.`));
  }

  private progress(run: Run): void {
    const now = performance.now();
    const elapsed = now - run.lastProgressAt;
    if (elapsed < PROGRESS_INTERVAL_MS) return;
    const { job } = run;
    const speed = Math.max(0, job.receivedBytes - run.lastProgressBytes) / (elapsed / 1000);
    job.bytesPerSecond = job.bytesPerSecond === null ? speed : job.bytesPerSecond * 0.7 + speed * 0.3;
    run.lastProgressAt = now;
    run.lastProgressBytes = job.receivedBytes;
    this.emit(job);
  }

  private async verify(run: Run, targets: Target[]): Promise<void> {
    const { job, control: { signal } } = run;
    signal.throwIfAborted();
    job.state = 'verifying';
    job.bytesPerSecond = null;
    job.receivedBytes = job.totalBytes;
    await this.persist();
    this.emit(job);
    for (const target of targets) {
      const digest = await sha256File(target.alreadyFinal ? target.final : target.part, signal);
      if (digest === target.sha256) continue;
      if (target.alreadyFinal) throw new DownloadFailure(FILE_EXISTS);
      await rm(target.part, { force: true, maxRetries: 3 });
      delete this.parts[target.part];
      throw new DownloadFailure(HASH_MISMATCH);
    }
  }

  /**
   * Every file matched its hash: they take their final names, then the caller is told. The line says `done` only after
   * onDone: a crash before that replays the (idempotent) verification and onDone at the next resume().
   */
  private async commit(run: Run, targets: Target[]): Promise<void> {
    const { job } = run;
    run.control.signal.throwIfAborted();
    run.committing = true;
    for (const target of targets) {
      if (target.alreadyFinal) await rm(target.part, { force: true, maxRetries: 3 });
      else await renameWithRetry(target.part, target.final);
      delete this.parts[target.part];
    }
    job.finalPath = targets[0].final;
    await this.persist();
    try {
      await this.onDone({ ...clone(job), state: 'done', error: null, bytesPerSecond: null });
    } catch (error) {
      throw new DownloadFailure(`Le modèle est téléchargé et vérifié, mais son ajout a échoué : ${(error as Error).message}`);
    }
    job.state = 'done';
    this.emit(job);
    await this.persist();
  }
}
