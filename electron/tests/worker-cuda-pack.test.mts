// The CUDA pack in the engine (hardware and offload, Task 10): an installed pack is tried first, a corrupt or stale
// one leaves the app on Vulkan or the processor with an exact French notice, the user's gpu_backend choice is applied
// once per worker, and the worker installs, cancels and uninstalls the pack. Real worker.mjs, real node-llama-cpp,
// real stories260K, mkdtemp homes; the pack is served by a local fake server, never downloaded for real.
//
// Each worker that creates a Llama runs in its own Node process (processWorker): two llama.cpp backends' binaries
// in one process once killed the whole tests/all.mts run (2026-10-18), and these tests pick the backend on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { getModuleVersion } from 'node-llama-cpp';
import { writePack, type CudaPackManifest } from '../core/cuda-pack-format.mts';
import { CUDA_PACK_TURN_BUSY, cudaPackUrlRefused } from '../core/cuda-pack.mts';
import { cudaFallbackNotice, cudaMismatchNotice, cudaMissingNotice } from '../core/llama-runtime.mts';
import { SettingsService } from '../core/settings.mts';
import { writeInstalledPack } from './support/fake-cuda-pack.mts';
import { startFakePackServer } from './support/fake-pack-server.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const ENGINE = await getModuleVersion();
const WORKER_URL = new URL('../worker.mjs', import.meta.url);

interface WorkerPort {
  on(event: 'message', listener: (message: any) => void): unknown;
  off(event: 'message', listener: (message: any) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<unknown>;
}

/** worker.mjs as a worker thread of a separate Node process, with `workerData`, its messages relayed over IPC. */
function processWorker(env: NodeJS.ProcessEnv, workerData: Record<string, unknown>): WorkerPort {
  const relay = `
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(new URL(${JSON.stringify(WORKER_URL.href)}), { execArgv: ['--experimental-strip-types'], workerData: ${JSON.stringify(workerData)} });
    worker.on('message', message => process.send(message));
    worker.on('error', error => { console.error(error); process.exit(1); });
    process.on('message', message => worker.postMessage(message));
    process.on('disconnect', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', relay], {
    env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced',
  });
  return {
    on: (event, listener) => child.on(event, listener),
    off: (event, listener) => child.off(event, listener),
    postMessage: message => { child.send(message as any); },
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}

function callWorker(worker: WorkerPort, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `cuda-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

type T = { after(fn: () => unknown): void; diagnostic?(message: string): void };

/** A temp root with a data home, a project folder, a copy of stories260K and a synthetic pack (parts + manifest). */
async function fixture(t: T, config?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-cuda-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const model = join(root, 'stories260K.gguf');
  await copyFile(fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url)), model);
  const files = [
    ['node_modules/@node-llama-cpp/win-x64-cuda/package.json', '{"name":"@node-llama-cpp/win-x64-cuda"}\n'],
    ['cuda-runtime/cublas64_13.dll', 'x'.repeat(20_000)],
    ['cuda-runtime/LICENSE.txt', 'NVIDIA licence (synthetic).\n'],
  ];
  const sources = [];
  for (const [path, bytes] of files) {
    const source = join(root, 'src', ...path.split('/'));
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, bytes);
    sources.push({ path, source });
  }
  const packDir = join(root, 'pack');
  const manifest: CudaPackManifest = await writePack(sources, packDir, { nodeLlamaCppVersion: ENGINE, chunkBytes: 4096 });
  return { root, home, folder, model, packDir, manifest, manifestPath: join(packDir, 'manifest.json') };
}

function start(t: T, home: string, workerData: Record<string, unknown>): WorkerPort {
  const worker = processWorker({ ...process.env, OPENAGENT_HOME: home }, workerData);
  terminateAtEnd(t, worker);
  return worker;
}

/** Resolves with every agent event of `runId` once that run has ended. */
function runEvents(worker: WorkerPort): { events: any[]; ended(runId: string): Promise<any> } {
  const events: any[] = [];
  const waiters = new Map<string, (event: any) => void>();
  worker.on('message', (message: any) => {
    if (message?.type !== 'event' || message.event !== 'agent') return;
    events.push(message);
    if (['done', 'error', 'stopped'].includes(message.kind)) waiters.get(message.runId)?.(message);
  });
  return {
    events,
    ended: runId => {
      const already = events.find(event => event.runId === runId && ['done', 'error', 'stopped'].includes(event.kind));
      return already ? Promise.resolve(already) : new Promise(resolve => waiters.set(runId, resolve));
    },
  };
}

test('1. a corrupt installed pack: the engine falls back with the exact notice, and a real turn still answers', { timeout: 300000 }, async t => {
  const f = await fixture(t);
  await writeInstalledPack(f.home, { engineVersion: ENGINE, corrupt: true });
  // As main.cjs does once it has put this pack's runtime on PATH (prepareGpuBackend).
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath, cudaRuntimeDir: join(f.home, 'cuda-pack', 'current', 'cuda-runtime') });
  const status = await callWorker(worker, 'cuda-pack-status');
  assert.equal(status.state, 'installed', 'the corrupt pack looks installed: only loading it can tell');
  const info = await callWorker(worker, 'hardware-info', {});
  assert.notEqual(info.backend, 'cuda');
  assert.equal(info.notice, cudaFallbackNotice(info.backend));
  assert.equal(info.backendChoice, 'auto');
  assert.equal(info.restartRequired, false);

  const runs = runEvents(worker);
  const entry = await callWorker(worker, 'gguf-add', { path: f.model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const { runId } = await callWorker(worker, 'send', { folder: f.folder, branchId: 'main', text: 'Once upon a time' });
  const end = await runs.ended(runId);
  assert.equal(end.kind, 'done', JSON.stringify(end));
  const text = runs.events.filter(e => e.runId === runId && e.kind === 'message' && e.message?.role === 'assistant').map(e => String(e.message.content ?? '')).join('');
  assert.ok(text.trim().length > 0, 'the turn answered with text');
});

test('2. a pack of another engine version is never loaded: mismatch, Vulkan notice', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await writeInstalledPack(f.home, { engineVersion: '3.0.0', corrupt: false });
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath });
  const status = await callWorker(worker, 'cuda-pack-status');
  assert.equal(status.state, 'mismatch');
  assert.equal(status.installedVersion, '3.0.0');
  const info = await callWorker(worker, 'hardware-info', {});
  assert.notEqual(info.backend, 'cuda');
  assert.equal(info.notice, cudaMismatchNotice('3.0.0', ENGINE));
});

test('3. cuda-pack-install through the worker: progress events, then done; installed; uninstall → absent', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const server = await startFakePackServer(f.packDir);
  t.after(() => server.close());
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath, cudaPackBaseUrl: server.url });
  const events: any[] = [];
  const finished = new Promise<any>(resolve => worker.on('message', (message: any) => {
    if (message?.type !== 'event' || message.event !== 'cuda-pack') return;
    events.push(message);
    if (message.state !== 'progress') resolve(message);
  }));
  const before = await callWorker(worker, 'cuda-pack-status');
  assert.deepEqual(before, {
    state: 'absent', downloadBytes: f.manifest.downloadBytes, installedBytes: f.manifest.installedBytes, installedVersion: null,
    expectedVersion: ENGINE, restartRequired: false, notice: null, install: null,
  });
  const { installId } = await callWorker(worker, 'cuda-pack-install');
  assert.equal(typeof installId, 'string');
  const end = await finished;
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.equal(end.installId, installId);
  const progress = events.filter(e => e.state === 'progress');
  assert.ok(progress.length >= 1, 'at least one progress event');
  for (const e of progress) {
    assert.equal(e.installId, installId);
    assert.equal(e.totalBytes, f.manifest.downloadBytes);
    assert.ok(e.receivedBytes > 0 && e.receivedBytes <= e.totalBytes);
  }
  // Mechanism B (D-CUDA-2) puts the runtime on PATH before the worker starts: a pack installed now is used at the
  // next app start (D-CUDA-4), so the restart is required even though no Llama exists in this worker yet.
  const installed = await callWorker(worker, 'cuda-pack-status');
  assert.equal(installed.state, 'installed');
  assert.equal(installed.restartRequired, true);
  assert.deepEqual(await callWorker(worker, 'cuda-pack-cancel', { installId }), { cancelled: false }, 'nothing left to cancel');
  const removed = await callWorker(worker, 'cuda-pack-uninstall');
  assert.equal(removed.state, 'absent');
  assert.equal(removed.restartRequired, false, 'back to what this worker started with');
});

test('3b. cuda-pack-status names the running install and its progress: a view opened mid-install can cancel it', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  // Sends the first 100 bytes of the first part (the whole synthetic pack is a few hundred), then holds the connection
  // open: the install stays running.
  const server = await startFakePackServer(f.packDir, { stallAfter: 100 });
  t.after(() => server.close());
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath, cudaPackBaseUrl: server.url });
  const ended = new Promise<any>(resolve => worker.on('message', (message: any) => {
    if (message?.type === 'event' && message.event === 'cuda-pack' && message.state !== 'progress') resolve(message);
  }));
  const { installId } = await callWorker(worker, 'cuda-pack-install');
  let status: any;
  const deadline = Date.now() + 30000;
  for (;;) {
    status = await callWorker(worker, 'cuda-pack-status');
    if (status.install?.receivedBytes > 0) break;
    assert.ok(Date.now() < deadline, `no progress in cuda-pack-status: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.install.installId, installId, 'the running install, by its id');
  assert.equal(status.install.totalBytes, f.manifest.downloadBytes);
  assert.ok(status.install.receivedBytes <= status.install.totalBytes);
  // What a freshly mounted view does: cancel with the id it read from the status.
  assert.deepEqual(await callWorker(worker, 'cuda-pack-cancel', { installId: status.install.installId }), { cancelled: true });
  const end = await ended;
  assert.equal(end.state, 'cancelled', JSON.stringify(end));
  const after = await callWorker(worker, 'cuda-pack-status');
  assert.equal(after.install, null, 'no install once it has ended');
  assert.equal(after.state, 'absent');
});

test('4. installing or uninstalling during a turn is refused with CUDA_PACK_TURN_BUSY', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const server = await startFakePackServer(f.packDir);
  t.after(() => server.close());
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath, cudaPackBaseUrl: server.url });
  const runs = runEvents(worker);
  const entry = await callWorker(worker, 'gguf-add', { path: f.model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const { runId } = await callWorker(worker, 'send', { folder: f.folder, branchId: 'main', text: 'Once upon a time' });
  await assert.rejects(callWorker(worker, 'cuda-pack-install'), { message: CUDA_PACK_TURN_BUSY });
  await assert.rejects(callWorker(worker, 'cuda-pack-uninstall'), { message: CUDA_PACK_TURN_BUSY });
  assert.equal(server.requests.length, 0, 'nothing was downloaded');
  await callWorker(worker, 'stop', { runId });
  await runs.ended(runId);
  assert.equal((await callWorker(worker, 'cuda-pack-status')).state, 'absent');
});

test('5. gpu_backend « cpu » in the settings: the worker runs on the processor; a new choice asks for a restart', { timeout: 120000 }, async t => {
  const f = await fixture(t, { gpu_backend: 'cpu' });
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath });
  const info = await callWorker(worker, 'hardware-info', {});
  assert.equal(info.backend, 'cpu');
  assert.equal(info.backendChoice, 'cpu');
  assert.equal(info.notice, null);
  assert.equal(info.restartRequired, false);
  await callWorker(worker, 'save-global-settings', { patch: { gpu_backend: 'vulkan' } });
  const after = await callWorker(worker, 'hardware-info', {});
  assert.equal(after.backend, 'cpu', 'the backend is decided once per worker');
  assert.equal(after.backendChoice, 'cpu', 'the choice this worker started with');
  assert.equal(after.restartRequired, true);
  assert.equal((await callWorker(worker, 'cuda-pack-status')).restartRequired, true);
});

test("5b. main and the worker must agree on the pack: without main's runtime folder, an installed pack is never activated", { timeout: 180000 }, async t => {
  // A valid pack of this engine (no addon binary: an activation would fail with cudaFallbackNotice, never silently).
  const f = await fixture(t, { gpu_backend: 'cuda' });
  await writeInstalledPack(f.home, { engineVersion: ENGINE, corrupt: false });
  const worker = start(t, f.home, { cudaPackManifest: f.manifestPath, cudaRuntimeDir: null });
  assert.equal((await callWorker(worker, 'cuda-pack-status')).state, 'installed');
  const info = await callWorker(worker, 'hardware-info', {});
  assert.notEqual(info.backend, 'cuda');
  assert.equal(info.notice, cudaMissingNotice(info.backend), 'not activated: the plain fallback, not a failed load');
  assert.equal(info.restartRequired, true, 'the pack is used once main puts it on PATH, at the next start');

  // Another runtime folder than the installed pack's: the same.
  const g = await fixture(t);
  await writeInstalledPack(g.home, { engineVersion: ENGINE, corrupt: false });
  const other = start(t, g.home, { cudaPackManifest: g.manifestPath, cudaRuntimeDir: join(g.root, 'ailleurs', 'cuda-runtime') });
  const auto = await callWorker(other, 'hardware-info', {});
  assert.notEqual(auto.backend, 'cuda');
  assert.equal(auto.notice, null, 'auto without an activated pack: the default engine, no notice');
  assert.equal(auto.restartRequired, true);
});

test('6. a non-loopback cudaPackBaseUrl is refused at worker start', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const url = 'https://example.invalid/';
  const worker = new Worker(WORKER_URL, { env: { ...process.env, OPENAGENT_HOME: f.home }, workerData: { cudaPackManifest: f.manifestPath, cudaPackBaseUrl: url } });
  terminateAtEnd(t, worker);
  const [error] = await once(worker, 'error');
  assert.equal((error as Error).message, cudaPackUrlRefused(url));
});

// C-1 (final review): the release source comes from package.json's `repository` (electron-builder strips `build` from
// the packaged copy). With the shipped manifest and no test source, the worker offers the pack (absent, with its
// sizes) and logs no [cuda-pack] warning.
test('6b. without a test source, the worker reads its release source from package.json: absent with sizes, no [cuda-pack] warning', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const worker = new Worker(WORKER_URL, { env: { ...process.env, OPENAGENT_HOME: f.home }, workerData: { cudaPackManifest: f.manifestPath }, stderr: true });
  terminateAtEnd(t, worker);
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += chunk; });
  const status = await callWorker(worker, 'cuda-pack-status');
  assert.equal(status.state, 'absent', JSON.stringify(status));
  assert.equal(status.downloadBytes, f.manifest.downloadBytes);
  assert.doesNotMatch(stderr, /\[cuda-pack\]/);
});

test('7. main, before the worker: the pack runtime goes first on PATH only for a valid pack and a CUDA-capable choice', { timeout: 60000 }, async t => {
  const { prepareGpuBackend } = createRequire(import.meta.url)('../main.cjs');
  const f = await fixture(t);
  const runtime = join(f.home, 'cuda-pack', 'current', 'cuda-runtime');
  assert.deepEqual(await prepareGpuBackend(f.home, { PATH: 'X:/bin' }), { gpuBackend: 'auto', runtimeDir: null }, 'no pack');
  await writeInstalledPack(f.home, { engineVersion: ENGINE, corrupt: false });
  const env: Record<string, string> = { PATH: 'X:/bin' };
  assert.deepEqual(await prepareGpuBackend(f.home, env), { gpuBackend: 'auto', runtimeDir: runtime });
  assert.equal(env.PATH, `${runtime};X:/bin`);
  for (const choice of ['vulkan', 'cpu']) {
    await new SettingsService(f.home).saveGlobal({ gpu_backend: choice });
    const untouched = { PATH: 'X:/bin' };
    assert.deepEqual(await prepareGpuBackend(f.home, untouched), { gpuBackend: choice, runtimeDir: null });
    assert.equal(untouched.PATH, 'X:/bin');
  }
  // A pack of another engine version, or one reached through a junction, never reaches PATH.
  const stale = await mkdtemp(join(tmpdir(), 'openagent-gpu-stale-'));
  removeAtEnd(t, stale);
  await writeInstalledPack(stale, { engineVersion: '3.0.0', corrupt: false });
  assert.deepEqual(await prepareGpuBackend(stale, { PATH: 'X:/bin' }), { gpuBackend: 'auto', runtimeDir: null });
  const linked = await mkdtemp(join(tmpdir(), 'openagent-gpu-link-'));
  removeAtEnd(t, linked);
  await symlink(join(f.home, 'cuda-pack'), join(linked, 'cuda-pack'), 'junction');
  assert.deepEqual(await prepareGpuBackend(linked, { PATH: 'X:/bin' }), { gpuBackend: 'auto', runtimeDir: null });
});

/** Runs `body` (an ES module) in a fresh Node process, as its main thread or inside a worker thread of it. */
async function runIsolated(root: string, body: string, inWorker: boolean): Promise<any> {
  const script = join(root, `probe-${inWorker ? 'worker' : 'main'}.mjs`);
  await writeFile(script, body);
  const entry = join(root, `entry-${inWorker ? 'worker' : 'main'}.mjs`);
  await writeFile(entry, inWorker
    ? `import { Worker } from 'node:worker_threads';
       const worker = new Worker(${JSON.stringify(script)});
       worker.on('message', message => { process.stdout.write('RESULT ' + JSON.stringify(message) + '\\n'); process.exit(0); });
       worker.on('error', error => { console.error(error); process.exit(1); });`
    : `import ${JSON.stringify(pathToFileURL(script).href)};`);
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const [code] = await once(child, 'exit');
  const line = out.split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (exit ${code}): ${out}`);
  return JSON.parse(line!.slice('RESULT '.length));
}

test('8. the resolve hook maps the bare CUDA specifier to the pack inside a worker thread, never in a main thread', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await writeInstalledPack(f.home, { engineVersion: ENGINE, corrupt: true });
  const dir = join(f.home, 'cuda-pack', 'current');
  const runtime = new URL('../core/llama-runtime.mts', import.meta.url).href;
  const body = `
    import { isMainThread, parentPort } from 'node:worker_threads';
    const rt = await import(${JSON.stringify(runtime)});
    const dir = ${JSON.stringify(dir)};
    rt.setCudaPackSource({ installedDir: async () => dir, status: async () => ({ state: 'installed', downloadBytes: null, installedBytes: null, installedVersion: ${JSON.stringify(ENGINE)}, expectedVersion: ${JSON.stringify(ENGINE)} }) });
    rt.setRuntimeStart({ choice: 'auto', packDir: dir });
    const llama = await rt.runtimeLlama();
    let binsDir = null;
    try { binsDir = (await import('@node-llama-cpp/win-x64-cuda')).getBinsDir().binsDir; } catch { binsDir = null; }
    const result = { binsDir, backend: rt.backendOf(llama), notice: rt.runtimeNotice() };
    await llama.dispose();
    if (isMainThread) { process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n'); process.exit(0); }
    else parentPort.postMessage(result);`;
  // The probe lives in the temp root: without the hook, the bare specifier has no node_modules to resolve from.
  const inWorker = await runIsolated(f.root, body, true);
  assert.equal(inWorker.binsDir, join(dir, 'node_modules', '@node-llama-cpp', 'win-x64-cuda', 'bins'), 'the pack\'s own copy was resolved');
  assert.notEqual(inWorker.backend, 'cuda');
  assert.equal(inWorker.notice, cudaFallbackNotice(inWorker.backend));
  const inMain = await runIsolated(f.root, body, false);
  assert.equal(inMain.binsDir, null, 'no hook in a main thread');
  assert.equal(inMain.notice, cudaFallbackNotice(inMain.backend), 'refused there, and the engine still starts');
});

test('gpu_backend setting: default auto, the four values accepted, anything else refused', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-gpu-backend-'));
  removeAtEnd(t, home);
  const settings = new SettingsService(home);
  assert.equal((await settings.publicGlobal()).gpu_backend, 'auto');
  for (const value of ['auto', 'cuda', 'vulkan', 'cpu']) {
    await settings.saveGlobal({ gpu_backend: value });
    assert.equal((await settings.publicGlobal()).gpu_backend, value);
  }
  for (const value of ['CUDA', 'metal', '', null, false]) {
    await assert.rejects(settings.saveGlobal({ gpu_backend: value }), { message: 'Paramètre invalide : gpu_backend' }, JSON.stringify(value));
  }
  assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).gpu_backend, 'cpu');
});

test('the French notices, exactly', () => {
  assert.equal(cudaFallbackNotice('vulkan'), "Le pack CUDA n'a pas pu se charger : l'app utilise Vulkan à la place.");
  assert.equal(cudaFallbackNotice('cpu'), "Le pack CUDA n'a pas pu se charger : l'app utilise le processeur à la place.");
  assert.equal(cudaMismatchNotice('3.0.0', '3.21.1'), "Le pack CUDA installé (moteur 3.0.0) ne correspond plus à cette version de l'app (moteur 3.21.1) : l'app utilise Vulkan. Télécharge le pack à jour.");
});
