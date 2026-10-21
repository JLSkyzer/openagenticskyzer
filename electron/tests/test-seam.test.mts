// The test seam (tests/support/test-model-provider.mts): a scripted model client reachable ONLY through
// workerData.testProviderModule, which no production code ever sets. Every worker and window test that drives the
// agent against a fake OpenAI server on 127.0.0.1 goes through it, so those proofs survive the removal of the
// production HTTP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { createTestProvider, testWorkerOptions } from './support/test-model-provider.mts';

const require = createRequire(import.meta.url);
const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

/** Sends one turn and waits for its outcome: the rejection of the request, or the run's terminal event. */
async function sendAndSettle(worker: Worker, payload: unknown): Promise<{ rejected?: Error; kinds: string[] }> {
  const events: any[] = [];
  const listener = (message: any) => { if (message?.type === 'event' && message.event === 'agent') events.push(message); };
  worker.on('message', listener);
  try {
    let runId: string;
    try { ({ runId } = await callWorker(worker, 'send', payload)); } catch (error) { return { rejected: error as Error, kinds: [] }; }
    const mine = () => events.filter(e => e.runId === runId);
    while (!mine().some(e => ['done', 'error', 'stopped'].includes(e.kind))) await new Promise(resolve => setTimeout(resolve, 20));
    return { kinds: mine().map(e => e.kind) };
  } finally { worker.off('message', listener); }
}

async function fakeServer(t: { after(fn: () => unknown): void }) {
  const state = { requests: 0, port: 0 };
  const server = createServer((request, response) => {
    state.requests++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  state.port = (server.address() as { port: number }).port;
  return state;
}

async function folders(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-test-seam-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(folder)]);
  return { home, folder };
}

test('test seam: createTestProvider refuses any non-loopback base_url', () => {
  for (const url of ['https://openrouter.ai/api/v1', 'http://localhost:1/v1', 'http://127.0.0.1.evil.example/v1'])
    assert.throws(() => createTestProvider({ base_url: url }), /seule une adresse http:\/\/127\.0\.0\.1/);
});

test('test seam: a worker given workerData.testProviderModule runs a turn against the fake server', async t => {
  const server = await fakeServer(t);
  const { home, folder } = await folders(t);
  const worker = terminateAtEnd(t, new Worker(WORKER, testWorkerOptions(home)));
  const { rejected, kinds } = await sendAndSettle(worker, { folder, branchId: 'main', text: 'salut', testModel: { base_url: `http://127.0.0.1:${server.port}/v1` } });
  assert.equal(rejected, undefined);
  assert.equal(kinds.at(-1), 'done', `events: ${kinds.join(',')}`);
  assert.equal(server.requests, 1);
});

test('test seam: a worker built without it ignores payload.testModel — the fake server never receives a request', async t => {
  const server = await fakeServer(t);
  const { home, folder } = await folders(t);
  const worker = terminateAtEnd(t, new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home } }));
  const outcome = await sendAndSettle(worker, { folder, branchId: 'main', text: 'salut', testModel: { base_url: `http://127.0.0.1:${server.port}/v1` } });
  assert.ok(outcome.rejected || outcome.kinds.length, 'the send reached an outcome');
  assert.equal(server.requests, 0);
});

test('main never passes the test seam to the worker, packaged or not, whatever the environment', () => {
  const saved = process.env.OPENAGENT_TEST_PROVIDER;
  process.env.OPENAGENT_TEST_PROVIDER = '1';
  try {
    const { workerOptions } = require('../main.cjs');
    for (const isPackaged of [true, false])
      assert.equal('testProviderModule' in workerOptions({ isPackaged, resourcesPath: 'C:\\r', appDir: 'C:\\a' }).workerData, false);
    for (const isPackaged of [true, false]) {
      const { workerData } = workerOptions({ isPackaged, resourcesPath: 'C:\\r', appDir: 'C:\\a' });
      assert.deepEqual(Object.keys(workerData), ['modelsDir', 'cudaPackManifest', 'gpuBackend', 'cudaRuntimeDir']);
      // Test-only: a download source other than the app's own GitHub release is never passed by main.
      assert.equal('cudaPackBaseUrl' in workerData, false);
      assert.equal(workerData.gpuBackend, 'auto', 'no choice read: auto');
      assert.equal(workerData.cudaRuntimeDir, null, 'no pack runtime put on PATH: none for the worker either');
    }
    // What prepareGpuBackend put on PATH, so the worker activates the pack only when it is the same one.
    assert.equal(workerOptions({ isPackaged: true, resourcesPath: 'C:\\r', appDir: 'C:\\a', cudaRuntimeDir: 'C:\\h\\cuda-pack\\current\\cuda-runtime' }).workerData.cudaRuntimeDir, 'C:\\h\\cuda-pack\\current\\cuda-runtime');
    assert.equal(workerOptions({ isPackaged: true, resourcesPath: 'C:\\r', appDir: 'C:\\a', gpuBackend: 'cpu' }).workerData.gpuBackend, 'cpu');
    // The CUDA pack manifest is the copy shipped with the app: extraResources once packaged, resources/ otherwise.
    assert.equal(workerOptions({ isPackaged: true, resourcesPath: 'C:\\r', appDir: 'C:\\a' }).workerData.cudaPackManifest, 'C:\\r\\cuda-pack\\manifest.json');
    assert.equal(workerOptions({ isPackaged: false, resourcesPath: 'C:\\r', appDir: 'C:\\a' }).workerData.cudaPackManifest, 'C:\\a\\resources\\cuda-pack\\manifest.json');
    // The bundled embedding model: extraResources once packaged, the repository's resources/models otherwise.
    assert.equal(workerOptions({ isPackaged: true, resourcesPath: 'C:\\r', appDir: 'C:\\a' }).workerData.modelsDir, 'C:\\r\\models');
    assert.equal(workerOptions({ isPackaged: false, resourcesPath: 'C:\\r', appDir: 'C:\\a' }).workerData.modelsDir, 'C:\\a\\resources\\models');
  } finally {
    if (saved === undefined) delete process.env.OPENAGENT_TEST_PROVIDER; else process.env.OPENAGENT_TEST_PROVIDER = saved;
  }
  // What production really does: startBackend builds its Worker from workerOptions(...), and from nothing else.
  const mainSource = readFileSync(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  const startBackend = mainSource.match(/\nfunction startBackend\(\) \{\n([\s\S]*?)\n\}\n/)?.[1] ?? '';
  assert.match(startBackend, /new Worker\(path\.join\(__dirname, 'worker\.mjs'\), workerOptions\(\{[^)]*\}\)\)/, 'startBackend builds its Worker through workerOptions(...)');
  assert.equal((mainSource.match(/new Worker\(/g) ?? []).length, 1, 'main.cjs builds no other Worker');
  // A guard only: the packaged app's real content is checked by the asar inspection of the packaging run.
  const files: string[] = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).build.files;
  assert.equal(files.some(entry => /^!?tests\b/.test(entry)), false, 'tests/** (the seam module) is never packaged');
});
