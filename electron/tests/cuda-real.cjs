// The real CUDA pack on this machine's NVIDIA GPU (hardware and offload, Task 12). MANUAL, outside the suite, run
// once each by the lot's final check; it needs the real pack built in build/cuda-pack (npm run cuda-pack:build) and
// the committed resources/cuda-pack/manifest.json. Run by Electron, as the app runs worker.mjs, in TWO processes:
// the backend is decided once per process (D-CUDA-4), so the pack installed by the first is loaded by the second.
//
//   npx electron tests/cuda-real.cjs --install <temp home>
//     serves build/cuda-pack on 127.0.0.1 only and installs the pack into <temp home> through the real worker
//     (cuda-pack-install, cudaPackBaseUrl = that loopback server: nothing is downloaded from the network);
//   npx electron tests/cuda-real.cjs --load <same temp home>
//     puts the installed pack's cuda-runtime/ first on PATH (as main.cjs::prepareGpuBackend), starts the worker
//     without a base URL, activates stories260K.gguf, sends one message and prints the backend, the placement and
//     the reply length. PASS iff the backend is cuda, every layer is on the GPU and the reply is not empty.
//
// <temp home> is a throwaway folder (mkdtemp): never the real ~/.openagent.
const { app } = require('electron');
const { Worker } = require('node:worker_threads');
const { createServer } = require('node:http');
const { createReadStream, readFileSync } = require('node:fs');
const { copyFile, lstat, mkdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ELECTRON_DIR = path.join(__dirname, '..');
const PACK_DIR = path.join(ELECTRON_DIR, 'build', 'cuda-pack');
const MANIFEST = path.join(ELECTRON_DIR, 'resources', 'cuda-pack', 'manifest.json');
const FIXTURE_MODEL = path.join(__dirname, 'fixtures', 'stories260K.gguf');

function parseArgs(argv) {
  const modes = ['--install', '--load'].filter(flag => argv.includes(flag));
  if (modes.length !== 1) throw new Error('Usage : electron tests/cuda-real.cjs --install <dossier temporaire> | --load <dossier temporaire>');
  const home = argv[argv.indexOf(modes[0]) + 1];
  if (!home || home.startsWith('--')) throw new Error(`${modes[0]} attend le dossier de données temporaire.`);
  const resolved = path.resolve(home);
  if (resolved.toLowerCase() === path.join(os.homedir(), '.openagent').toLowerCase()) throw new Error('Refusé : jamais le vrai ~/.openagent, seulement un dossier temporaire.');
  return { mode: modes[0], home: resolved };
}

/** build/cuda-pack on 127.0.0.1: plain file names of that folder only, streamed. */
async function servePack() {
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); res.end(); return; }
    const file = path.join(PACK_DIR, name);
    let stat;
    try { stat = await lstat(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

function startWorker(workerData) {
  const worker = new Worker(path.join(ELECTRON_DIR, 'worker.mjs'), { type: 'module', workerData });
  worker.on('error', error => { console.error(`worker: ${error.stack || error}`); });
  return worker;
}

function call(worker, op, payload) {
  return new Promise((resolve, reject) => {
    const id = `cuda-real-${Math.random()}`;
    const listener = message => {
      if (message?.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

function waitForEvent(worker, accept, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error(`délai dépassé : ${what}`)); }, timeoutMs);
    const listener = message => {
      if (message?.type !== 'event' || !accept(message)) return;
      clearTimeout(timer);
      worker.off('message', listener);
      resolve(message);
    };
    worker.on('message', listener);
  });
}

async function install(home) {
  const server = await servePack();
  const worker = startWorker({ cudaPackManifest: MANIFEST, cudaPackBaseUrl: server.url });
  try {
    const before = await call(worker, 'cuda-pack-status');
    process.stdout.write(`before: ${JSON.stringify(before)}\n`);
    let last = 0;
    worker.on('message', message => {
      if (message?.type === 'event' && message.event === 'cuda-pack' && message.state === 'progress' && Date.now() - last > 5000) {
        last = Date.now();
        process.stdout.write(`progress: ${message.receivedBytes}/${message.totalBytes}\n`);
      }
    });
    const ended = waitForEvent(worker, message => message.event === 'cuda-pack' && message.state !== 'progress', 30 * 60_000, 'fin de l\'installation');
    const { installId } = await call(worker, 'cuda-pack-install');
    const end = await ended;
    process.stdout.write(`install ${installId}: ${JSON.stringify(end)}\n`);
    const after = await call(worker, 'cuda-pack-status');
    process.stdout.write(`after: ${JSON.stringify(after)}\n`);
    const pass = end.state === 'done' && after.state === 'installed';
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} cuda-real --install\n`);
    return pass;
  } finally {
    await call(worker, 'shutdown').catch(() => {});
    await worker.terminate();
    server.close();
  }
}

async function load(home) {
  const { installedPackDir } = await import(pathToFileURL(path.join(ELECTRON_DIR, 'core', 'cuda-pack.mts')).href);
  const engineVersion = JSON.parse(readFileSync(path.join(ELECTRON_DIR, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version;
  const packDir = await installedPackDir(home, engineVersion);
  if (!packDir) throw new Error(`Aucun pack CUDA ${engineVersion} installé dans ${home} : lance d'abord --install.`);
  // As main.cjs::prepareGpuBackend: the pack's runtime first on PATH, before any Llama exists in this process.
  const runtimeDir = path.join(packDir, 'cuda-runtime');
  process.env.PATH = process.env.PATH ? `${runtimeDir}${path.delimiter}${process.env.PATH}` : runtimeDir;
  const worker = startWorker({ cudaPackManifest: MANIFEST, gpuBackend: 'auto', cudaRuntimeDir: runtimeDir });
  try {
    const work = path.join(home, 'cuda-real');
    const folder = path.join(work, 'projet');
    await mkdir(folder, { recursive: true });
    const model = path.join(work, 'stories260K.gguf');
    await copyFile(FIXTURE_MODEL, model);
    const entry = await call(worker, 'gguf-add', { path: model });
    await call(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });

    // Every agent event, the turn's end included, is recorded from BEFORE the send: a turn that ends before the send
    // reply arrives is still seen.
    const events = [];
    let onEnd = null;
    const isEnd = event => ['done', 'error', 'stopped'].includes(event.kind);
    worker.on('message', message => {
      if (message?.type !== 'event' || message.event !== 'agent') return;
      events.push(message);
      if (onEnd && isEnd(message)) onEnd();
    });
    const { runId } = await call(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
    const end = await new Promise((resolve, reject) => {
      const find = () => events.find(event => event.runId === runId && isEnd(event));
      const timer = setTimeout(() => reject(new Error('délai dépassé : fin du tour')), 10 * 60_000);
      onEnd = () => { const found = find(); if (found) { clearTimeout(timer); resolve(found); } };
      onEnd();
    });
    const reply = events
      .filter(event => event.runId === runId && event.kind === 'message' && event.message?.role === 'assistant')
      .map(event => String(event.message.content ?? ''))
      .join('');
    const info = await call(worker, 'hardware-info', {});
    const status = await call(worker, 'model-status');
    const placement = status.placement ?? null;
    process.stdout.write(`turn: ${end.kind}${end.kind === 'done' ? '' : ` ${JSON.stringify(end)}`}\n`);
    process.stdout.write(`hardware-info.backend: ${info.backend}${info.notice ? ` (notice: ${info.notice})` : ''}\n`);
    process.stdout.write(`placement: ${JSON.stringify(placement)}\n`);
    process.stdout.write(`reply length: ${reply.trim().length}\n`);
    const pass = info.backend === 'cuda' && placement !== null && placement.gpuLayers === placement.totalLayers && reply.trim().length > 0;
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} cuda-real --load\n`);
    return pass;
  } finally {
    await call(worker, 'shutdown').catch(() => {});
    await worker.terminate();
  }
}

async function main() {
  const { mode, home } = parseArgs(process.argv);
  await mkdir(home, { recursive: true });
  // The worker resolves its data home from OPENAGENT_HOME (core/data-home.cjs), read from this process's environment.
  process.env.OPENAGENT_HOME = home;
  return mode === '--install' ? install(home) : load(home);
}

main().then(
  pass => app.exit(pass ? 0 : 1),
  error => { process.stderr.write(`FAIL cuda-real: ${error.stack || error}\n`); app.exit(1); },
);
