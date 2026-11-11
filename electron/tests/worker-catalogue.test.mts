// The Hugging Face catalogue through the worker (Task 5): listing, variants, install, activation and the models folder,
// against the local fake Hugging Face (tests/support/fake-hf.mts, reached through workerData.hfBaseUrl): no test reaches
// the network, every home is a mkdtemp folder. The model files served are copies of the stories260K fixture, so the
// one model a turn loads is the toy model, never a real large one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  CatalogueService, CatalogueInstalls, ToolSupportChecker, checkHfTestBaseUrl, hfUrlRefused, REPO_REFUSED, CATALOGUE_TTL_MS,
} from '../core/catalogue-service.mts';
import { GgufLibrary } from '../core/gguf-library.mts';
import { SettingsService } from '../core/settings.mts';
import { HfError, type CatalogueModel, type ModelVariant } from '../core/hf-catalogue.mts';
import { HASH_MISMATCH, type DownloadJob } from '../core/model-download.mts';
import type { HardwareInfo } from '../core/hardware.mts';
import { startFakeHf } from './support/fake-hf.mts';
import { callWorker, recordAgentEvents } from './support/worker-events.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));
const STORIES_BYTES = new Uint8Array(readFileSync(STORIES));
const TEMPLATES = JSON.parse(readFileSync(new URL('./fixtures/chat-templates.json', import.meta.url), 'utf8')) as { id: string; expected: string; template: string }[];
// The shortest template the library gives a native tool syntax (Mistral's wrapper): quick to check.
const TOOLS_YES = TEMPLATES.filter(t => t.expected === 'yes').sort((a, b) => a.template.length - b.template.length)[0].template;
// Its Jinja runs for minutes: only a time limit ends its check (measured: still running after 120 s).
const HANGING = "{% for a in range(3000) %}{% for b in range(3000) %}{% endfor %}{% endfor %}{% for message in messages %}{{ message['content'] }}{% endfor %}";

type T = { after(fn: () => unknown): void; diagnostic?(message: string): void };

function hfEntry(id: string, template: string | null = TOOLS_YES, extra: Record<string, unknown> = {}) {
  return {
    id, downloads: 1000, likes: 10, gated: false, lastModified: '2026-11-01T00:00:00.000Z', tags: ['gguf'],
    gguf: { total: 1, architecture: 'llama', context_length: 4096, ...(template === null ? {} : { chat_template: template }) },
    ...extra,
  };
}

async function setup(t: T, options: { hfBaseUrl?: string } = {}) {
  const hf = await startFakeHf();
  t.after(() => hf.close());
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-catalogue-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home }, workerData: { hfBaseUrl: options.hfBaseUrl ?? hf.baseUrl } });
  terminateAtEnd(t, worker);
  return { hf, root, home, folder, worker };
}

/** Resolves with the first 'catalogue-download' job of `id` that satisfies `predicate` (listener set before the op). */
function jobEvents(worker: Worker) {
  const jobs: any[] = [];
  const waiters = new Set<() => void>();
  const listener = (message: any) => {
    if (message?.type !== 'event' || message.event !== 'catalogue-download') return;
    jobs.push(message.job);
    for (const wake of [...waiters]) wake();
  };
  worker.on('message', listener);
  return {
    jobs,
    until(predicate: (job: any) => boolean, ms = 60_000): Promise<any> {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = jobs.find(predicate);
          if (!found) return;
          clearTimeout(timer); waiters.delete(check); resolve(found);
        };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no such catalogue-download job; seen: ${JSON.stringify(jobs.map(j => j.state))}`)); }, ms);
        waiters.add(check);
        check();
      });
    },
    stop() { worker.off('message', listener); },
  };
}

const END = new Set(['done', 'error', 'cancelled']);

// ---- The service and the tool check, without the worker --------------------------------------------------------

const HARDWARE: HardwareInfo = {
  backend: 'cpu', gpuNames: [], vram: null, ram: { total: 32e9, free: 16e9 },
  cpu: { model: 'test', mathCores: 4, logicalCores: 8 }, nvidia: false, notice: null,
};

function model(id: string): CatalogueModel {
  return { id, downloads: 1, likes: 0, gated: false, lastModified: '', architecture: 'llama', contextLength: 4096, chatTemplate: null, tags: [] };
}
const variant = (name: string, sha256: string | null = 'a'.repeat(64)): ModelVariant => ({ name, files: [{ path: `${name}.gguf`, size: 1000, sha256 }], totalBytes: 1000 });

test('CatalogueService: variants for the first 20 models only, 4 at a time, and the listing cached 1 hour per query and sort', async () => {
  let now = 1_000_000;
  const searches: unknown[] = [];
  const fetched: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const service = new CatalogueService({
    baseUrl: 'http://127.0.0.1:1', token: async () => undefined, hardware: async () => HARDWARE, contextSize: async () => 4096,
    toolSupport: async () => 'yes', now: () => now,
    search: async (options: any) => { searches.push({ query: options.query, sort: options.sort }); return Array.from({ length: 25 }, (_, i) => model(`owner/m${i}`)); },
    variants: async (id: string) => {
      fetched.push(id);
      running++; maxRunning = Math.max(maxRunning, running);
      await new Promise(resolve => setTimeout(resolve, 20));
      running--;
      return [variant(`${id.split('/')[1]}-Q4`)];
    },
  });
  const view = await service.list({ query: 'qwen', sort: 'downloads' });
  assert.equal(view.error, null);
  assert.deepEqual(fetched.sort(), Array.from({ length: 20 }, (_, i) => `owner/m${i}`).sort(), 'the first 20 only');
  assert.equal(maxRunning, 4, 'four at a time');
  assert.ok(view.items.length <= 20 && view.items.length > 0);
  for (const item of view.items) assert.ok(item.variant && item.score.estimated);
  assert.equal(view.recommendation.kind, 'install');

  await service.list({ query: 'qwen', sort: 'downloads' });
  assert.equal(searches.length, 1, 'same query and sort within the hour: from memory');
  await service.list({ query: 'qwen', sort: 'likes' });
  assert.equal(searches.length, 2, 'another sort: another listing');
  now += CATALOGUE_TTL_MS + 1;
  await service.list({ query: 'qwen', sort: 'downloads' });
  assert.equal(searches.length, 3, 'after an hour: read again');
});

test('CatalogueService: Hugging Face unreachable → error offline, recommendation none/offline, no throw, nothing cached', async () => {
  let searches = 0;
  const service = new CatalogueService({
    baseUrl: 'http://127.0.0.1:1', token: async () => undefined, hardware: async () => HARDWARE, contextSize: async () => 4096,
    toolSupport: async () => 'yes',
    search: async () => { searches++; throw new HfError('offline', 'Hugging Face est injoignable'); },
    variants: async () => [],
  });
  const view = await service.list({});
  assert.deepEqual(view, { recommendation: { kind: 'none', reason: 'offline' }, items: [], error: 'offline' });
  await service.list({});
  assert.equal(searches, 2, 'an offline answer is not kept');
});

test('CatalogueService: a restricted repository stays listed, not installable, with a sentence that says so', async () => {
  const service = new CatalogueService({
    baseUrl: 'http://127.0.0.1:1', token: async () => undefined, hardware: async () => HARDWARE, contextSize: async () => 4096,
    toolSupport: async () => 'yes',
    search: async () => [model('owner/open'), model('owner/closed')],
    variants: async (id: string) => { if (id === 'owner/closed') throw new HfError('gated', 'Accès refusé par Hugging Face (HTTP 401)'); return [variant('open-Q4')]; },
  });
  const view = await service.list({});
  const closed = view.items.find(item => item.model.id === 'owner/closed')!;
  assert.equal(closed.model.gated, true);
  assert.equal(closed.variant, null);
  assert.match(closed.score.sentence, /restreint/i);
  assert.equal(view.recommendation.kind === 'install' && view.recommendation.item.model.id, 'owner/open');
});

test('ToolSupportChecker: a template whose Jinja never ends is « unknown » at the time limit, off this thread, and cached', { timeout: 120_000 }, async t => {
  const checker = new ToolSupportChecker({ timeoutMs: 1500 });
  t.after(() => checker.close());
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const hung = await checker.check(HANGING);
  clearInterval(ticker);
  assert.equal(hung, 'unknown');
  assert.ok(ticks >= 10, `this thread kept running during the check (${ticks} ticks)`);
  assert.equal(await checker.check(TOOLS_YES), 'yes', 'the next template is still checked after a stuck one');
  const again = Date.now();
  assert.equal(await checker.check(HANGING), 'unknown');
  assert.ok(Date.now() - again < 200, 'the same template text is answered from the cache');
  assert.ok(Date.now() - started < 60_000);
  assert.equal(await checker.check(''), 'unknown');
  assert.equal(await checker.check(null), 'unknown');
});

// onDone runs before the job's line says `done` (Task 4): a crash in between replays it at the next start.
test('CatalogueInstalls: the end step replayed after a crash keeps one library entry, the same id, and the model active', { timeout: 60_000 }, async t => {
  const hf = await startFakeHf();
  t.after(() => hf.close());
  const home = await mkdtemp(join(tmpdir(), 'openagent-catalogue-installs-'));
  removeAtEnd(t, home);
  hf.setFile('owner/tiny-GGUF/tiny-Q4.gguf', STORIES_BYTES);
  const library = new GgufLibrary(home);
  const settings = new SettingsService(home);
  const open = (jobs: DownloadJob[]) => {
    const installs = new CatalogueInstalls({ home, library, settings, baseUrl: hf.baseUrl, freeBytes: async () => 1e15, onChange: job => { jobs.push(job); } });
    t.after(() => installs.close());
    return installs;
  };
  const first: DownloadJob[] = [];
  const installs = open(first);
  const variantOf: ModelVariant = { name: 'tiny-Q4', files: [{ path: 'tiny-Q4.gguf', size: STORIES_BYTES.length, sha256: createHash('sha256').update(STORIES_BYTES).digest('hex') }], totalBytes: STORIES_BYTES.length };
  const dir = join(home, 'models');
  const job = await installs.install('owner/tiny-GGUF', variantOf, dir, true);
  while (!first.some(j => j.id === job.id && END.has(j.state))) await new Promise(resolve => setTimeout(resolve, 10));
  const [entry] = await library.list();
  assert.equal((await settings.global()).active_local_model, entry.id);
  await installs.close();

  // The state a crash between onDone and the `done` line leaves: the line still pending, the wish still recorded.
  const done = first.find(j => j.id === job.id && j.state === 'done')!;
  await writeFile(join(home, 'model-downloads.json'), JSON.stringify({ jobs: [{ ...done, state: 'verifying', finalPath: null }], parts: {} }));
  await writeFile(join(home, 'catalogue-installs.json'), JSON.stringify({ activate: [JSON.stringify(['owner/tiny-GGUF', 'tiny-Q4', process.platform === 'win32' ? dir.toLowerCase() : dir])] }));
  const second: DownloadJob[] = [];
  await open(second).resume();
  while (!second.some(j => j.id === job.id && END.has(j.state))) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(second.find(j => END.has(j.state))!.state, 'done');
  assert.deepEqual((await library.list()).map(e => e.id), [entry.id], 'the same entry, not a second one');
  assert.equal((await settings.global()).active_local_model, entry.id);
});

test('checkHfTestBaseUrl: only a loopback http URL with a port; anything else is refused', () => {
  assert.equal(checkHfTestBaseUrl('http://127.0.0.1:4567'), 'http://127.0.0.1:4567');
  for (const url of ['https://huggingface.co', 'http://localhost:1', 'http://127.0.0.1', 'http://127.0.0.1.evil.example:1', 42]) {
    assert.throws(() => checkHfTestBaseUrl(url), { message: hfUrlRefused(String(url)) });
  }
});

// ---- Through the real worker ----------------------------------------------------------------------------------

test('worker: a non-loopback hfBaseUrl is refused at worker start', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-catalogue-'));
  removeAtEnd(t, root);
  const url = 'https://example.invalid';
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: root }, workerData: { hfBaseUrl: url } });
  terminateAtEnd(t, worker);
  const [error] = await once(worker, 'error');
  assert.equal((error as Error).message, hfUrlRefused(url));
});

test('worker catalogue-list: the recommendation, the items with their chosen variant and /5 score, no error', { timeout: 180_000 }, async t => {
  const { hf, worker } = await setup(t);
  hf.setModels([hfEntry('owner/Qwen2.5-Coder-mini-GGUF'), { id: 'broken' }]);
  hf.setFile('owner/Qwen2.5-Coder-mini-GGUF/mini-Q4_K_M.gguf', STORIES_BYTES);
  hf.setFile('owner/Qwen2.5-Coder-mini-GGUF/mini-Q8_0.gguf', STORIES_BYTES.slice(0, 1000));
  const view = await callWorker(worker, 'catalogue-list', { query: 'coder', sort: 'downloads' });
  assert.equal(view.error, null);
  assert.equal(view.items.length, 1, 'the entry without gguf is dropped');
  const [item] = view.items;
  assert.equal(item.model.id, 'owner/Qwen2.5-Coder-mini-GGUF');
  assert.equal(item.score.tools, 'yes');
  assert.equal(item.score.code, 'good');
  assert.equal(item.score.estimated, true);
  assert.equal(typeof item.score.stars, 'number');
  assert.ok(item.variant, 'a variant is chosen');
  assert.equal(item.variant.name, 'mini-Q4_K_M', 'the largest one that fits');
  assert.equal(view.recommendation.kind, 'install');
  assert.equal(view.recommendation.item.model.id, 'owner/Qwen2.5-Coder-mini-GGUF');
  const search = hf.hits.find(hit => hit.path.startsWith('/api/models?'))!;
  assert.match(search.path, /search=coder/);

  const detail = await callWorker(worker, 'catalogue-variants', { repo: 'owner/Qwen2.5-Coder-mini-GGUF' });
  assert.deepEqual(detail.variants.map((v: any) => v.name).sort(), ['mini-Q4_K_M', 'mini-Q8_0']);
  assert.equal(detail.chosen, 'mini-Q4_K_M');
  for (const v of detail.variants) assert.ok(['full', 'partial', 'slow', 'none'].includes(v.fit));
});

test('worker catalogue-list offline: error offline and recommendation none/offline, never a thrown op', { timeout: 120_000 }, async t => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise(resolve => closed.close(resolve));
  const { worker } = await setup(t, { hfBaseUrl: `http://127.0.0.1:${port}` });
  const view = await callWorker(worker, 'catalogue-list', {});
  assert.deepEqual(view, { recommendation: { kind: 'none', reason: 'offline' }, items: [], error: 'offline' });
});

test('worker: a repository id with a dot segment or a bad shape is refused before any request', { timeout: 60_000 }, async t => {
  const { hf, worker } = await setup(t);
  for (const repo of ['owner/..', '../x', 'a/b/c', '', 42, 'owner/.']) {
    await assert.rejects(callWorker(worker, 'catalogue-variants', { repo }), { message: REPO_REFUSED }, String(repo));
    await assert.rejects(callWorker(worker, 'catalogue-install', { repo, variantName: 'x', activate: true }), { message: REPO_REFUSED }, String(repo));
  }
  assert.equal(hf.hits.length, 0);
});

test('worker catalogue-install with activate: downloaded into <home>/models, in the library, and active', { timeout: 120_000 }, async t => {
  const { hf, home, worker } = await setup(t);
  hf.setFile('owner/tiny-GGUF/tiny-Q4.gguf', STORIES_BYTES);
  const events = jobEvents(worker);
  const job = await callWorker(worker, 'catalogue-install', { repo: 'owner/tiny-GGUF', variantName: 'tiny-Q4', activate: true });
  assert.equal(job.repo, 'owner/tiny-GGUF');
  const done = await events.until(j => j.id === job.id && END.has(j.state));
  assert.equal(done.state, 'done', done.error);
  const path = join(home, 'models', 'tiny-Q4.gguf');
  assert.ok(existsSync(path));
  const library = await callWorker(worker, 'gguf-list');
  const entry = library.find((e: any) => e.path === path);
  assert.ok(entry, 'the file is in the library');
  assert.equal(entry.size_bytes, STORIES_BYTES.length);
  const settings = await callWorker(worker, 'global-settings');
  assert.equal(settings.active_local_model, entry.id);
  assert.equal(settings.models_dir, '');
  const listed = await callWorker(worker, 'catalogue-downloads');
  assert.ok(listed.some((j: any) => j.id === job.id));
  events.stop();
});

test('worker catalogue-install: a file that does not match its SHA-256 is not added and active_local_model is unchanged', { timeout: 120_000 }, async t => {
  const { hf, root, worker } = await setup(t);
  const old = join(root, 'old.gguf');
  await copyFile(STORIES, old);
  const before = await callWorker(worker, 'gguf-add', { path: old });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: before.id } });
  hf.setFile('owner/bad-GGUF/bad-Q4.gguf', STORIES_BYTES, { sha256: 'b'.repeat(64) });
  const events = jobEvents(worker);
  const job = await callWorker(worker, 'catalogue-install', { repo: 'owner/bad-GGUF', variantName: 'bad-Q4', activate: true });
  const end = await events.until(j => j.id === job.id && END.has(j.state));
  assert.equal(end.state, 'error');
  assert.equal(end.error, HASH_MISMATCH);
  assert.equal((await callWorker(worker, 'global-settings')).active_local_model, before.id);
  assert.deepEqual((await callWorker(worker, 'gguf-list')).map((e: any) => e.id), [before.id]);
  events.stop();
});

test('worker: models_dir is where the catalogue downloads; changing it keeps the model already in the library', { timeout: 120_000 }, async t => {
  const { hf, root, worker } = await setup(t);
  const chosen = join(root, 'mes modèles');
  await assert.rejects(callWorker(worker, 'save-global-settings', { patch: { models_dir: 'relatif/modeles' } }), /models_dir/);
  await callWorker(worker, 'save-global-settings', { patch: { models_dir: chosen } });
  hf.setFile('owner/tiny-GGUF/tiny-Q4.gguf', STORIES_BYTES);
  const events = jobEvents(worker);
  const job = await callWorker(worker, 'catalogue-install', { repo: 'owner/tiny-GGUF', variantName: 'tiny-Q4', activate: false });
  const done = await events.until(j => j.id === job.id && END.has(j.state));
  assert.equal(done.state, 'done', done.error);
  const path = join(chosen, 'tiny-Q4.gguf');
  assert.ok(existsSync(path), 'downloaded into the chosen folder');
  const [entry] = await callWorker(worker, 'gguf-list');
  assert.equal(entry.path, path);
  assert.equal((await callWorker(worker, 'global-settings')).active_local_model, '', 'not activated when not asked');

  await callWorker(worker, 'save-global-settings', { patch: { models_dir: join(root, 'ailleurs') } });
  assert.deepEqual((await callWorker(worker, 'gguf-list')).map((e: any) => e.path), [path], 'nothing moved, nothing lost');
  events.stop();
});

test('worker catalogue-cancel: a held download is cancelled and its job says so', { timeout: 120_000 }, async t => {
  const { hf, worker } = await setup(t);
  let release!: () => void;
  hf.setFile('owner/slow-GGUF/slow-Q4.gguf', STORIES_BYTES, { gate: new Promise<void>(resolve => { release = resolve; }) });
  t.after(() => release());
  const events = jobEvents(worker);
  const job = await callWorker(worker, 'catalogue-install', { repo: 'owner/slow-GGUF', variantName: 'slow-Q4', activate: true });
  await events.until(j => j.id === job.id && j.state === 'downloading');
  await callWorker(worker, 'catalogue-cancel', { id: job.id });
  const end = await events.until(j => j.id === job.id && END.has(j.state));
  assert.equal(end.state, 'cancelled');
  assert.equal((await callWorker(worker, 'global-settings')).active_local_model, '');
  events.stop();
});

// Review Focus 3: the turn keeps the model it started with; the new one answers from the next send.
test('worker: an install that completes during a turn — the turn\'s model is the old one, the next send the new one', { timeout: 300_000 }, async t => {
  const { hf, root, folder, worker } = await setup(t);
  const old = join(root, 'ancien.gguf');
  await copyFile(STORIES, old);
  const before = await callWorker(worker, 'gguf-add', { path: old });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: before.id } });
  let release!: () => void;
  hf.setFile('owner/new-GGUF/new-Q4.gguf', STORIES_BYTES, { gate: new Promise<void>(resolve => { release = resolve; }) });
  t.after(() => release());

  const models: any[] = [];
  const onModel = (message: any) => { if (message?.type === 'event' && message.event === 'model') models.push(message); };
  worker.on('message', onModel);
  t.after(() => worker.off('message', onModel));
  const events = jobEvents(worker);
  const job = await callWorker(worker, 'catalogue-install', { repo: 'owner/new-GGUF', variantName: 'new-Q4', activate: true });
  await events.until(j => j.id === job.id && j.state === 'downloading');

  const rec = recordAgentEvents(worker);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  await rec.first(runId, event => event.kind === 'delta', 120_000);  // the turn has its model and is generating
  release();
  const done = await events.until(j => j.id === job.id && END.has(j.state));
  assert.equal(done.state, 'done', done.error);
  const newEntry = (await callWorker(worker, 'gguf-list')).find((e: any) => e.path === done.finalPath);
  assert.equal((await callWorker(worker, 'global-settings')).active_local_model, newEntry.id, 'the new model is the active one');
  const turnEndedBeforeInstall = rec.of(runId).some(event => END.has(event.kind) || event.kind === 'stopped');
  const turn = await rec.until(runId, { timeoutMs: 240_000 });
  assert.equal(turn.at(-1).kind, 'done', JSON.stringify(turn.find(e => e.kind === 'error')));
  assert.equal(turnEndedBeforeInstall, false, 'the install completed while the turn was still running');
  assert.ok(models.length > 0, 'the turn posted its model');
  for (const status of models) assert.equal(status.id, before.id, 'every model event of that turn names the model it started with');

  const count = models.length;
  const next = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'And then' });
  await rec.first(next.runId, event => event.kind === 'delta', 120_000);
  await callWorker(worker, 'stop', { runId: next.runId });
  await rec.until(next.runId, { timeoutMs: 120_000 });
  rec.stop();
  const after = models.slice(count);
  assert.ok(after.length > 0, 'the next send posted its model');
  assert.equal(after[0].id, newEntry.id, 'the next send runs on the new model');
  events.stop();
});
