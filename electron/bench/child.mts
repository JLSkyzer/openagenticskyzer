// One bench session, in its own process (bench/run.mts spawns it): the real worker (worker.mjs) on a temp data home,
// driven exactly as the app drives it — the model added to the library and made active, each folder activated, one
// `send` per message — then each turn's figures read back from that turn's own turn log lines.
// Usage (internal): node --experimental-strip-types bench/child.mts <config.json>
// The worker always ends with the `shutdown` op, never `terminate()` (lesson 2026-10-24: terminating a thread inside
// native code crashes the process).
import { Worker } from 'node:worker_threads';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { turnLogDir } from '../core/turn-log.mts';
import { PERF_LEVERS_ENV } from '../core/perf-levers.mts';
import { turnFigures, type TurnFigures } from './metrics.mts';
import { sampleMemory } from './memory.mts';

export interface ChildGroup { scenario: TurnFigures['scenario']; folder: string; messages: readonly string[] }
export interface ChildConfig {
  home: string;
  model: string;
  context: number | 'max';
  /** The levers, as OPENAGENT_PERF_LEVERS (JSON). */
  levers: string;
  groups: ChildGroup[];
  /** Folders whose indexing (started by the worker itself: restore_last_folder) must settle before the first send. */
  settle: string[];
  resultPath: string;
}
export interface ChildResult { turns: TurnFigures[]; failures: string[]; folders: string[] }

const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const INDEX_WAIT_MS = 300000;

function call(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `bench-${Math.random()}`;
    const listener = (message: any) => {
      if (message?.id !== id) return;
      worker.off('message', listener);
      if (message.ok) resolve(message.result); else reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

/** Waits until `folder` is not being indexed (F29: the activation's indexing would add noise to the turn). */
async function indexSettled(worker: Worker, folder: string): Promise<void> {
  const until = Date.now() + INDEX_WAIT_MS;
  for (;;) {
    const status = await call(worker, 'index-status', { folder });
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

/** Sends `text` and resolves with the run's terminal event; a permission request is refused (nothing waits for a
 * person here). */
function sendAndWait(worker: Worker, folder: string, text: string): Promise<{ runId: string; end: any }> {
  return new Promise((resolve, reject) => {
    let runId: string | null = null;
    const early: any[] = [];
    const onEvent = (message: any) => {
      if (message?.type !== 'event' || message.event !== 'agent') return;
      if (runId === null) { early.push(message); return; }
      handle(message);
    };
    const handle = (message: any) => {
      if (message.runId !== runId) return;
      if (message.kind === 'permission-request') void call(worker, 'permission-decision', { requestId: message.requestId, allow: false }).catch(() => {});
      if (['done', 'error', 'stopped'].includes(message.kind)) {
        worker.off('message', onEvent);
        resolve({ runId: runId!, end: message });
      }
    };
    worker.on('message', onEvent);
    call(worker, 'send', { folder, branchId: 'main', text }).then(result => {
      runId = String(result.runId);
      for (const message of early.splice(0)) handle(message);
    }, error => { worker.off('message', onEvent); reject(error); });
  });
}

async function shutdown(worker: Worker): Promise<void> {
  const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
  await call(worker, 'shutdown').catch(() => undefined);
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 120000))]);
}

export async function runSession(config: ChildConfig): Promise<ChildResult> {
  const result: ChildResult = { turns: [], failures: [], folders: [] };
  const worker = new Worker(WORKER, {
    env: { ...process.env, OPENAGENT_HOME: config.home, [PERF_LEVERS_ENV]: config.levers },
    workerData: { perfLeversAllowed: true },
  });
  let crashed: Error | null = null;
  worker.on('error', error => { crashed = error; console.error(`[bench] le worker s'est arrêté : ${error.message}`); });
  try {
    const entry = await call(worker, 'gguf-add', { path: config.model });
    await call(worker, 'save-global-settings', { patch: { active_local_model: entry.id, local_context: config.context } });
    for (const folder of config.settle) await indexSettled(worker, folder);
    for (const group of config.groups) {
      const { folder } = await call(worker, 'activate_folder', { folder: group.folder });
      result.folders.push(folder);
      await indexSettled(worker, folder);
      for (const [index, text] of group.messages.entries()) {
        const message = index + 1;
        console.info(`[bench] ${group.scenario}·${message}`);
        const { runId, end } = await sendAndWait(worker, folder, text);
        if (end.kind !== 'done') result.failures.push(`${group.scenario}·${message} : ${end.kind}${end.message ? ` — ${end.message}` : ''}`);
        const status = await call(worker, 'model-status').catch(() => null);
        const p = status?.loaded ? status.placement : null;
        const placement = p ? { backend: p.backend, gpuLayers: p.gpuLayers, totalLayers: p.totalLayers, contextSize: p.contextSize, vramBytes: p.vramBytes, ramBytes: p.ramBytes } : null;
        result.turns.push(turnFigures(await turnLines(config.home, runId), { scenario: group.scenario, message, memory: await sampleMemory(), placement, perfLines: [] }));
      }
    }
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
  const result = await runSession(config);
  for (const failure of result.failures) console.error(`[bench] échec : ${failure}`);
  await writeFile(config.resultPath, JSON.stringify(result));
  process.exit(result.failures.length ? 4 : 0);
}
