// One bench step, in its own process (bench/run.mts spawns it), on a temp data home:
// - `install`: the local CUDA pack (build/cuda-pack) installed into that home through the real installer, served on
//   127.0.0.1 only (as tests/cuda-real.cjs --install): nothing is downloaded;
// - `session`: the real worker (worker.mjs) started as main.cjs starts it — the installed pack's cuda-runtime/ first
//   on PATH BEFORE any Llama exists in this process, `gpuBackend` and `cudaRuntimeDir` in workerData — then driven as
//   the app drives it: the model added to the library and made active, each folder activated, one `send` per message.
//   Each turn's figures are read back from that turn's own turn log lines, and the results file is rewritten after
//   every turn (a cut session keeps what it measured).
// Usage (internal): node --experimental-strip-types bench/child.mts <config.json>, spawned with an IPC channel.
// Stopping is the parent's: its `{ type: 'stop' }` message (sent on Ctrl+C) stops the turn in progress — or cancels
// the pack install — sends nothing more, shuts the worker down and writes what was measured. A parent that goes away
// (the channel disconnects) stops the child the same way, so no model stays loaded behind a dead bench.
// The worker always ends with the `shutdown` op, never `terminate()` (lesson 2026-10-24: terminating a thread inside
// native code crashes the process).
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { metadataDirectory } from '../core/json-store.mts';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { turnLogDir } from '../core/turn-log.mts';
import { PERF_LEVERS_ENV, SHIPPED_LEVERS, type PerfLevers } from '../core/perf-levers.mts';
import { installedPackDir } from '../core/cuda-pack.mts';
import { callWorker, hardwareInfo } from '../tests/support/worker-events.mts';
import { turnFigures, type TurnFigures } from './metrics.mts';
import { sampleMemory } from './memory.mts';

export type Backend = 'auto' | 'cuda' | 'vulkan' | 'cpu';
export interface ChildGroup { scenario: TurnFigures['scenario']; folder: string; messages: readonly string[] }
interface Common { home: string; resultPath: string }
export interface InstallConfig extends Common {
  kind: 'install'; packDir: string;
  /** Past it, the install is cancelled through the worker and recorded as failed. */
  timeoutMs: number;
}
export interface SessionConfig extends Common {
  kind: 'session';
  model: string;
  context: number | 'max';
  /** The levers, as OPENAGENT_PERF_LEVERS (JSON). */
  levers: string;
  /** The worker's gpu_backend choice, as main.cjs passes it. */
  backend: Backend;
  /** The backend the engine must have started on, else no message is sent (a heavy run off CUDA). null: any. */
  requireBackend: Exclude<Backend, 'auto'> | null;
  /** A B reply without the read_file call or without the sentinel is a failure (a real model). */
  qualityGate: boolean;
  turnTimeoutMs: number;
  groups: ChildGroup[];
  /** Folders whose indexing (started by the worker itself: restore_last_folder) must settle before the first send. */
  settle: string[];
  /** `--touch-memory n` (Task 4): before A's message n, a line is appended to A's project memory.md (null: never). */
  touchMemoryBefore?: number | null;
  /** `--idle-before-send ms` (Task 7): the session starts as the app does when the user waits before writing. The model
   * is made active by a first worker that then quits (the lever engineAtBoot reads it at start), the measured worker
   * gets no op before the first message (no hardware-info: the Matériel tab is not open), and that message is sent
   * this long after the worker's start. The backend is then read after that first turn. null: as before. */
  idleBeforeSendMs?: number | null;
  /** `--mcp-fake ms` (Task 7, ruling F13): a global MCP server (the tests' fake one) whose initialize answers after this
   * long, written in the home's mcp.json before the worker starts: each turn's tool preparation waits for it. */
  mcpFakeMs?: number | null;
  /** `--setting key=value` (Task 9, ruling F20): global settings saved through save-global-settings with the model's
   * activation, as Réglages would save them (e.g. max_thought_tokens). Absent or {}: none. */
  settings?: Record<string, unknown>;
}

/** What `--touch-memory` appends to the project memory: a change in the project context, as a save_memory makes. */
export const TOUCH_MEMORY_TEXT = "\n<!-- bench -->\n- Le banc d'essai a noté une préférence.";

/** Appends TOUCH_MEMORY_TEXT to `folder`'s project memory.md, at the path the worker itself reads (context.mts:
 * metadataDirectory), creating it when absent. */
export async function touchProjectMemory(folder: string): Promise<void> {
  const dir = await metadataDirectory(folder);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'memory.md'), TOUCH_MEMORY_TEXT, 'utf8');
}
export type ChildConfig = InstallConfig | SessionConfig;
export interface ChildResult {
  turns: TurnFigures[]; failures: string[]; folders: string[];
  /** The engine's backend (hardware-info), the levers the worker applied (its model-ready line). */
  backend: string | null; levers: Readonly<PerfLevers> | null;
}

const ELECTRON = fileURLToPath(new URL('..', import.meta.url));
const WORKER = join(ELECTRON, 'worker.mjs');
const MANIFEST = join(ELECTRON, 'resources', 'cuda-pack', 'manifest.json');
const FAKE_MCP_SERVER = join(ELECTRON, 'tests', 'fixtures', 'fake-mcp-server.cjs');
const INDEX_WAIT_MS = 300000;
const STOP_WAIT_MS = 120000;

const engineVersion = async () => JSON.parse(await readFile(join(ELECTRON, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version as string;

/** Waits until `folder` is not being indexed (F29: the activation's indexing would add noise to the turn). */
async function indexSettled(worker: Worker, folder: string): Promise<void> {
  const until = Date.now() + INDEX_WAIT_MS;
  for (;;) {
    const status = await callWorker(worker, 'index-status', { folder });
    if (status?.state !== 'indexing') return;
    if (Date.now() > until) {
      console.warn('[bench] indexation toujours en cours après 300 s : le tour part quand même');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function turnLines(home: string, runId: string): Promise<Record<string, unknown>[]> {
  const dir = turnLogDir(home);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  const text = (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => line.runId === runId);
}

/** The run (or pack install) in progress, for a timeout or a stop: its run id once known, and how to stop it. */
let current: { runId: string | null; stop: () => void } | null = null;
let interrupted = false;
/** The parent's stop (or its going away): nothing more is sent, the step in progress ends. Idempotent. */
function interrupt(): void {
  interrupted = true;
  current?.stop();
}

/** Sends `text` and resolves with the run's terminal event. A permission request is refused (nothing waits for a person
 * here). Past `timeoutMs` — or on Ctrl+C — the run is stopped through the worker's own `stop` op, and its terminal
 * event (« stopped ») ends it as for a user's stop; `timedOut` says so. */
function sendAndWait(worker: Worker, folder: string, text: string, timeoutMs: number): Promise<{ runId: string; end: any; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let runId: string | null = null;
    let timedOut = false;
    let stopAsked = false;
    const early: any[] = [];
    const stop = () => {
      if (stopAsked || runId === null) return;
      stopAsked = true;
      void callWorker(worker, 'stop', { runId }).catch(() => {});
      // A worker that never ends the run after the stop: give up on it, the session ends.
      setTimeout(() => finish({ kind: 'stopped', message: "le tour n'a pas pris fin après l'arrêt" }), STOP_WAIT_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    let ended = false;
    const finish = (end: any) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      worker.off('message', onEvent);
      current = null;
      resolve({ runId: runId!, end, timedOut });
    };
    const handle = (message: any) => {
      if (message.runId !== runId) return;
      if (message.kind === 'permission-request') void callWorker(worker, 'permission-decision', { requestId: message.requestId, allow: false }).catch(() => {});
      if (['done', 'error', 'stopped'].includes(message.kind)) finish(message);
    };
    const onEvent = (message: any) => {
      if (message?.type !== 'event' || message.event !== 'agent') return;
      if (runId === null) early.push(message); else handle(message);
    };
    worker.on('message', onEvent);
    current = { runId: null, stop };
    callWorker(worker, 'send', { folder, branchId: 'main', text }).then(result => {
      runId = String(result.runId);
      if (current) current.runId = runId;
      for (const message of early.splice(0)) handle(message);
      if (interrupted || timedOut) stop();
    }, error => { clearTimeout(timer); worker.off('message', onEvent); current = null; reject(error); });
  });
}

async function shutdown(worker: Worker): Promise<void> {
  const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
  await callWorker(worker, 'shutdown').catch(() => undefined);
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 120000))]);
}

/** build/cuda-pack on 127.0.0.1: plain file names of that folder only, streamed (as tests/cuda-real.cjs). */
async function servePack(packDir: string): Promise<{ url: string; close(): void }> {
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); res.end(); return; }
    const file = join(packDir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

export async function installPack(config: InstallConfig): Promise<ChildResult> {
  const result: ChildResult = { turns: [], failures: [], folders: [], backend: null, levers: null };
  const server = await servePack(config.packDir);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: config.home }, workerData: { cudaPackManifest: MANIFEST, cudaPackBaseUrl: server.url } });
  try {
    const ended = new Promise<any>(resolve => {
      const listener = (message: any) => {
        if (message?.type !== 'event' || message.event !== 'cuda-pack' || message.state === 'progress') return;
        worker.off('message', listener);
        resolve(message);
      };
      worker.on('message', listener);
    });
    const { installId } = await callWorker(worker, 'cuda-pack-install');
    // Bounded (a stalled copy must not hold the session): past timeoutMs, or on a stop, the worker cancels the install
    // and its terminal event (« cancelled ») follows; a worker that sends none within STOP_WAIT_MS is given up on.
    let why: string | null = null;
    let cancelled!: () => void;
    const cancelAsked = new Promise<void>(resolve => { cancelled = resolve; });
    const cancel = (reason: string) => {
      if (why) return;
      why = reason;
      void callWorker(worker, 'cuda-pack-cancel', { installId }).catch(() => {});
      cancelled();
    };
    const timer = setTimeout(() => cancel(`délai dépassé (${Math.round(config.timeoutMs / 1000)} s)`), config.timeoutMs);
    current = { runId: null, stop: () => cancel('interrompu') };
    if (interrupted) cancel('interrompu');
    let giveUp: NodeJS.Timeout | undefined;
    const end = await Promise.race([ended, cancelAsked.then(() => new Promise<any>(resolve => {
      giveUp = setTimeout(() => resolve({ state: 'cancelled', message: "pas de fin après l'annulation" }), STOP_WAIT_MS);
    }))]);
    clearTimeout(timer);
    clearTimeout(giveUp);
    current = null;
    const after = await callWorker(worker, 'cuda-pack-status');
    // Installed is installed, even when the bound fell at the same moment (M6).
    const installed = end.state === 'done' && after?.state === 'installed';
    if (!installed && why) result.failures.push(`pack CUDA non installé : ${why}, installation annulée`);
    else if (!installed) result.failures.push(`pack CUDA non installé : ${end.state}${end.message ? ` — ${end.message}` : ''}`);
  } catch (error) {
    result.failures.push(`pack CUDA non installé : ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    current = null;
    await shutdown(worker);
    server.close();
  }
  return result;
}

export async function runSession(config: SessionConfig, save: (result: ChildResult) => Promise<void>): Promise<ChildResult> {
  const result: ChildResult = { turns: [], failures: [], folders: [], backend: null, levers: null };
  // As main.cjs::prepareGpuBackend: the pack's runtime first on PATH, before any Llama exists in this process.
  let cudaRuntimeDir: string | null = null;
  if (config.backend === 'auto' || config.backend === 'cuda') {
    const packDir = await installedPackDir(config.home, await engineVersion());
    if (packDir) {
      cudaRuntimeDir = join(packDir, 'cuda-runtime');
      process.env.PATH = process.env.PATH ? `${cudaRuntimeDir}${delimiter}${process.env.PATH}` : cudaRuntimeDir;
    }
  }
  const workerData = { perfLeversAllowed: true, cudaPackManifest: MANIFEST, gpuBackend: config.backend, cudaRuntimeDir };
  const idleMs = config.idleBeforeSendMs ?? null;
  if (config.mcpFakeMs != null) {
    await writeFile(join(config.home, 'mcp.json'), JSON.stringify([{
      id: 'banc-mcp', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_INIT_DELAY_MS: String(config.mcpFakeMs) }, added_at: new Date().toISOString(),
    }]));
  }
  const activate = async (target: Worker) => {
    const entry = await callWorker(target, 'gguf-add', { path: config.model });
    await callWorker(target, 'save-global-settings', { patch: { ...config.settings, active_local_model: entry.id, local_context: config.context } });
  };
  // `--idle-before-send`: the model is made active before the measured worker starts, by a worker that creates no Llama
  // (no hardware-info), so the measured one starts its engine itself — at boot with engineAtBoot, else on the turn.
  if (idleMs !== null) {
    const setup = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: config.home }, workerData });
    try { await activate(setup); } finally { await shutdown(setup); }
  }
  const worker = new Worker(WORKER, {
    env: { ...process.env, OPENAGENT_HOME: config.home, [PERF_LEVERS_ENV]: config.levers },
    workerData,
  });
  const workerStart = Date.now();
  let crashed: Error | null = null;
  worker.on('error', (error: Error) => { crashed = error; console.error(`[bench] le worker s'est arrêté : ${error.message}`); });
  /** The engine's backend, as hardware-info reads it; false (and a failure) when it is not the one required. */
  const checkBackend = async (when: string) => {
    const hardware = await hardwareInfo(worker);
    result.backend = typeof hardware?.backend === 'string' ? hardware.backend : null;
    console.info(`[bench] moteur ${result.backend ?? 'inconnu'} (choix ${config.backend}, pack CUDA ${cudaRuntimeDir ? 'activé' : 'absent'})`);
    if (config.requireBackend && result.backend !== config.requireBackend) {
      result.failures.push(`moteur ${result.backend ?? 'inconnu'} au lieu de ${config.requireBackend} : ${when}`);
      return false;
    }
    return true;
  };
  try {
    if (idleMs === null) {
      if (!await checkBackend('aucun message envoyé')) return result;
      await activate(worker);
    }
    for (const folder of config.settle) await indexSettled(worker, folder);
    for (const group of config.groups) {
      if (interrupted) break;
      const { folder } = await callWorker(worker, 'activate_folder', { folder: group.folder });
      result.folders.push(folder);
      await indexSettled(worker, folder);
      for (const [index, text] of group.messages.entries()) {
        if (interrupted) break;
        const message = index + 1;
        const name = `${group.scenario}·${message}`;
        if (group.scenario === 'A' && config.touchMemoryBefore === message) {
          await touchProjectMemory(folder);
          console.info(`[bench] mémoire du projet modifiée avant ${name}`);
        }
        const first = result.turns.length === 0;
        if (first && idleMs !== null) {
          const wait = Math.max(0, workerStart + idleMs - Date.now());
          console.info(`[bench] attente avant le premier message : ${wait} ms (${idleMs} ms après le démarrage du worker)`);
          await new Promise(resolve => setTimeout(resolve, wait));
        }
        console.info(`[bench] ${name}`);
        const { runId, end, timedOut } = await sendAndWait(worker, folder, text, config.turnTimeoutMs);
        if (timedOut) result.failures.push(`${name} : délai dépassé (${Math.round(config.turnTimeoutMs / 1000)} s), arrêté`);
        else if (end.kind !== 'done') result.failures.push(`${name} : ${end.kind}${end.message ? ` — ${end.message}` : ''}`);
        const status = await callWorker(worker, 'model-status').catch(() => null);
        const p = status?.loaded ? status.placement : null;
        const placement = p ? { backend: p.backend, gpuLayers: p.gpuLayers, totalLayers: p.totalLayers, contextSize: p.contextSize, vramBytes: p.vramBytes, ramBytes: p.ramBytes } : null;
        const lines = await turnLines(config.home, runId);
        // The levers this worker applied (M8): on its model-ready line, only when one is away from its shipped value.
        const ready = lines.find(line => line.event === 'model-ready');
        if (ready && result.levers === null) result.levers = (ready.levers as PerfLevers | undefined) ?? SHIPPED_LEVERS;
        const figures = turnFigures(lines, { scenario: group.scenario, message, memory: await sampleMemory(), placement, perfLines: [] });
        if (figures.status === null && end.kind) figures.status = end.kind;
        if (config.qualityGate && group.scenario === 'B' && !(figures.quality.toolCalled && figures.quality.sentinel)) {
          result.failures.push(`${name} : qualité manquée (read_file ${figures.quality.toolCalled ? 'appelé' : 'non appelé'}, code ${figures.quality.sentinel ? 'cité' : 'non cité'})`);
        }
        result.turns.push(figures);
        await save(result);
        // `--idle-before-send`: the backend is known only now (hardware-info before the turn would start the engine).
        if (first && idleMs !== null && !await checkBackend('aucun autre message envoyé')) return result;
      }
    }
    if (interrupted) result.failures.push('interrompu (arrêt demandé par le banc)');
  } catch (error) {
    result.failures.push(`session interrompue : ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!crashed) await shutdown(worker);
  }
  return result;
}

const configPath = process.argv[2];
if (configPath && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config: ChildConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const save = (result: ChildResult) => writeFile(config.resultPath, JSON.stringify(result));
  // The parent's stop message, or the parent gone (its channel closed): the turn in progress is stopped through the
  // worker, nothing more is sent, the worker shuts down normally and what was measured is written. A Ctrl+C that
  // reaches this process directly (same console) does the same; the parent kills it on a second Ctrl+C.
  process.on('message', (message: any) => { if (message?.type === 'stop') interrupt(); });
  process.on('disconnect', interrupt);
  process.on('SIGINT', interrupt);
  const result = config.kind === 'install' ? await installPack(config) : await runSession(config, save);
  for (const failure of result.failures) console.error(`[bench] échec : ${failure}`);
  await save(result);
  process.exit(result.failures.length ? 4 : 0);
}
