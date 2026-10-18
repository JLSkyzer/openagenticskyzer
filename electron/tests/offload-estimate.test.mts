// The background offload estimate (hardware and offload, Task 5): node-llama-cpp's own layer resolver run without
// loading the model, its persisted cache, and the one-at-a-time jobs. Real node-llama-cpp, real stories260K.gguf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, stat, utimes, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimatePlacement, estimateAndRemember, estimateKey, hardwareKey, EstimateCache, ESTIMATE_CACHE_LIMIT, REMOTE_ESTIMATE_LATER,
  type EstimatePhase, type ModelSource,
} from '../core/offload-estimate.mts';
import { EstimateJobs, type EstimateOutcome } from '../core/estimate-jobs.mts';
import { loadLocalModel, disposeEngine } from '../core/local-engine.mts';
import { runtimeLlama } from '../core/llama-runtime.mts';
import type { Placement } from '../core/placement.mts';
import { removeAtEnd } from './teardown.mts';
import { withTrainContext } from './support/gguf-fixture.mts';

const execFileAsync = promisify(execFile);
const stories = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

async function tempHome(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openagent-estimate-'));
  removeAtEnd(t, root);
  return root;
}

const sample = (gpuLayers: number): Placement => ({
  source: 'estimate', backend: 'cpu', gpuLayers, totalLayers: 6, contextSize: 16384, vramBytes: 0, ramBytes: 1, memoryMeasured: false, fit: 'cpu',
});

/** Runs `body` in a Node process of its own (`e` = core/offload-estimate.mts, `m` = core/local-engine.mts,
 * `r` = core/llama-runtime.mts) and returns what it assigned to `out`. A child that never ends is killed. */
async function inChild(body: string, env: NodeJS.ProcessEnv = {}): Promise<any> {
  const source = `
    const e = await import(${JSON.stringify(new URL('../core/offload-estimate.mts', import.meta.url).href)});
    const m = await import(${JSON.stringify(new URL('../core/local-engine.mts', import.meta.url).href)});
    const r = await import(${JSON.stringify(new URL('../core/llama-runtime.mts', import.meta.url).href)});
    const out = {};
    ${body}
    await r.disposeLlama();
    process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n');`;
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 100000,
  });
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  assert.ok(line, `the child printed its result: ${stdout.slice(-500)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

test('estimatePlacement on stories260K gives the same layers, total and backend as the real load', { timeout: 120000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  const e = await estimatePlacement({ kind: 'file', path: stories }, { contextSize: 16384 });
  assert.equal(e.source, 'estimate');
  assert.equal(e.contextSize, 16384);
  assert.equal(e.memoryMeasured, false);
  const l = await loadLocalModel(stories, 16384);
  assert.equal(e.gpuLayers, l.gpuLayers, 'the estimate places the layers the load places');
  assert.equal(e.totalLayers, l.totalLayers);
  assert.equal(e.backend, l.backend);
  assert.equal(e.fit, l.fit);
  assert.ok(e.vramBytes + e.ramBytes > 0, `node-llama-cpp's own estimate: ${e.vramBytes} / ${e.ramBytes}`);
});

// Ruling F8, the card branch: run only when this process resolved a card. stories260K is 1 MB, so every layer fits.
test('on a card, the estimate puts every layer of stories260K on it, like the load', { timeout: 120000 }, async t => {
  const llama = await runtimeLlama();
  if (llama.gpu === false) { t.skip('no card in this process (backend cpu): the cpu branch is the next test'); return; }
  t.after(() => disposeEngine());
  const e = await estimatePlacement({ kind: 'file', path: stories }, { contextSize: 16384 });
  const l = await loadLocalModel(stories, 16384);
  assert.equal(e.backend, llama.gpu);
  assert.equal(e.gpuLayers, e.totalLayers);
  assert.equal(e.gpuLayers, l.gpuLayers);
  assert.equal(e.fit, 'gpu');
});

// Ruling F8, the cpu branch, in a process of its own: two backends' binaries in one process once killed the whole
// tests/all.mts run (2026-10-18).
test('a real estimate with NODE_LLAMA_CPP_GPU=false: cpu backend, 0 layers, fit cpu, and the load agrees', { timeout: 120000 }, async () => {
  const out = await inChild(`
    const path = ${JSON.stringify(stories)};
    out.estimate = await e.estimatePlacement({ kind: 'file', path }, { contextSize: 16384 });
    out.loaded = await m.loadLocalModel(path, 16384);
    await m.disposeEngine();`, { NODE_LLAMA_CPP_GPU: 'false' });
  assert.equal(out.estimate.backend, 'cpu');
  assert.equal(out.estimate.gpuLayers, 0);
  assert.equal(out.estimate.fit, 'cpu');
  assert.equal(out.estimate.source, 'estimate');
  assert.equal(out.loaded.backend, 'cpu');
  assert.equal(out.estimate.gpuLayers, out.loaded.gpuLayers, 'model.gpuLayers after the real load');
  assert.equal(out.estimate.totalLayers, out.loaded.totalLayers);
});

test('an abort during a phase rejects with AbortError and nothing is cached', { timeout: 60000 }, async t => {
  const home = await tempHome(t);
  const cache = new EstimateCache(home);
  const source: ModelSource = { kind: 'file', path: stories };
  const key = await estimateKey(source, 16384, await hardwareKey());
  const file = join(home, 'estimates.v1.json');
  const phases: EstimatePhase[] = ['stat', 'read', 'insights', 'layers', 'resources'];
  for (const phase of phases) {
    const controller = new AbortController();
    const seen: EstimatePhase[] = [];
    await assert.rejects(
      estimateAndRemember(cache, key, source, { contextSize: 16384, signal: controller.signal, onPhase: p => { seen.push(p); if (p === phase) controller.abort(); } }),
      { name: 'AbortError' },
      `aborted at ${phase}`,
    );
    assert.equal(seen.at(-1), phase, `stopped right after ${phase}: ${seen.join(',')}`);
    assert.equal(await cache.get(key), null, `nothing cached after an abort at ${phase}`);
    await assert.rejects(access(file), { code: 'ENOENT' }, `no cache file written after an abort at ${phase}`);
  }
  // Control: the same call, not aborted, does write the cache — so the absence above is the abort's doing.
  const done = await estimateAndRemember(cache, key, source, { contextSize: 16384 });
  assert.deepEqual(await cache.get(key), done);
  await access(file);
});

test('the cache key follows the file size and mtime, the hardware and the context', async t => {
  const home = await tempHome(t);
  const copy = join(home, 'model.gguf');
  await copyFile(stories, copy);
  const source: ModelSource = { kind: 'file', path: copy };
  const hardware = { backend: 'vulkan' as const, gpuNames: ['Carte'], vramTotal: 8 * 2 ** 30 };
  const base = await estimateKey(source, 16384, hardware);
  assert.equal(await estimateKey(source, 16384, { ...hardware, gpuNames: ['Carte'] }), base, 'same inputs, same key');
  assert.notEqual(await estimateKey(source, 32768, hardware), base, 'another context');
  assert.notEqual(await estimateKey(source, 16384, { ...hardware, vramTotal: hardware.vramTotal + 1 }), base, 'another card size');
  assert.notEqual(await estimateKey(source, 16384, { ...hardware, backend: 'cpu' }), base, 'another backend');
  const { mtime } = await stat(copy);
  await utimes(copy, mtime, new Date(mtime.getTime() + 1000));
  assert.notEqual(await estimateKey(source, 16384, hardware), base, 'the file changed (mtime + 1 s)');
  assert.notEqual(await estimateKey({ kind: 'remote', url: 'https://example.invalid/m.gguf' }, 16384, hardware), base);
});

test('EstimateCache persists in estimates.v1.json and keeps the last 64', async t => {
  const home = await tempHome(t);
  const cache = new EstimateCache(home);
  assert.equal(await cache.get('key 0'), null);
  for (let i = 0; i <= ESTIMATE_CACHE_LIMIT; i += 1) await cache.set(`key ${i}`, sample(i));
  const reopened = new EstimateCache(home);
  assert.deepEqual(await reopened.get(`key ${ESTIMATE_CACHE_LIMIT}`), sample(ESTIMATE_CACHE_LIMIT));
  assert.deepEqual(await reopened.get('key 1'), sample(1));
  assert.equal(await reopened.get('key 0'), null, 'the oldest of 65 is dropped');
  const saved = JSON.parse(await readFile(join(home, 'estimates.v1.json'), 'utf8'));
  assert.equal(saved.entries.length, ESTIMATE_CACHE_LIMIT);
  await assert.rejects(access(join(home, 'estimates.v1.json.pre-electron.bak')), { code: 'ENOENT' }, 'a cache keeps no backup copy');
});

test('a remote source is accepted by the type and refused with REMOTE_ESTIMATE_LATER', async () => {
  const phases: EstimatePhase[] = [];
  await assert.rejects(
    estimatePlacement({ kind: 'remote', url: 'https://example.invalid/model.gguf', etag: 'x' }, { contextSize: 16384, onPhase: p => phases.push(p) }),
    { message: REMOTE_ESTIMATE_LATER },
  );
  assert.deepEqual(phases, [], 'refused before any phase completes');
});

test('EstimateJobs: one key one job; another key cancels the running one; cancelAll aborts', async () => {
  const jobs = new EstimateJobs();
  const outcomes: EstimateOutcome[] = [];
  let runs = 0;
  const waitForAbort = (signal: AbortSignal) => {
    runs += 1;
    return new Promise<Placement>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const first = jobs.start('k1', waitForAbort, outcome => outcomes.push(outcome));
  assert.equal(first.reused, false);
  assert.equal(jobs.running, 1);
  const again = jobs.start('k1', waitForAbort, outcome => outcomes.push(outcome));
  assert.deepEqual(again, { id: first.id, reused: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1, 'k1 is running');
  const second = jobs.start('k2', waitForAbort, outcome => outcomes.push(outcome));
  assert.notEqual(second.id, first.id);
  assert.equal(jobs.running, 1, 'one at a time');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(outcomes, [{ id: first.id, state: 'cancelled' }], 'k1 ended cancelled, not error');
  assert.equal(runs, 2, 'k1 ran once, then k2 once it had ended');
  jobs.cancelAll();
  assert.equal(jobs.running, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(outcomes.at(-1), { id: second.id, state: 'cancelled' });
  assert.equal(jobs.cancel(second.id), false, 'an ended job is forgotten');
  // A job that finishes and one that fails.
  const ok = await new Promise<EstimateOutcome>(resolve => jobs.start('k3', async () => sample(3), resolve));
  assert.equal(ok.state, 'done');
  assert.deepEqual((ok as { estimate: Placement }).estimate, sample(3));
  const bad = await new Promise<EstimateOutcome>(resolve => jobs.start('k4', async () => { throw new Error('boom'); }, resolve));
  assert.deepEqual({ state: bad.state, message: (bad as { message: string }).message }, { state: 'error', message: 'boom' });
  assert.equal(jobs.running, 0);
});

// The Task 4 pre-check also guards the estimate: a hopeless size never reaches the native resolver (which can abort
// the whole process on a Vulkan card). In a process of its own in case it ever did, on the processor: a
// `node --input-type=module -e` child cannot resolve a card (node-llama-cpp's binary test fork() inherits execArgv and
// dies), so asking it for one would only test that failed fallback. The pre-check is pure JS and backend-independent.
test('a context the machine cannot hold is estimated « ne tient pas » before any native estimation', { timeout: 120000 }, async t => {
  const home = await tempHome(t);
  const patched = join(home, 'stories-huge.gguf');
  await withTrainContext(stories, patched, 2 ** 30);
  const out = await inChild(`
    const phases = [];
    out.estimate = await e.estimatePlacement({ kind: 'file', path: ${JSON.stringify(patched)} }, { contextSize: 2 ** 30, onPhase: p => phases.push(p) });
    out.phases = phases;`, { NODE_LLAMA_CPP_GPU: 'false' });
  assert.equal(out.estimate.fit, 'none');
  assert.equal(out.estimate.gpuLayers, 0);
  assert.equal(out.estimate.contextSize, 2 ** 30);
  assert.equal(out.estimate.source, 'estimate');
  assert.deepEqual(out.phases, ['stat', 'read', 'insights'], 'stopped before the layer resolution');
  assert.equal(out.estimate.backend, 'cpu');
});
