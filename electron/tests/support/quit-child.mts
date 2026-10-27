// A quit of the app, in a process of its own: main.cjs::stopWorker on a real worker with stories260K, at a moment given
// by argv[2], with stopWorker's cap in argv[3] (ms). A quit that ends the worker thread during a native call crashes the
// WHOLE process (0xC0000409), so tests/quit.test.mts runs this file as a child and reads its exit code. The last line
// of stdout is a JSON report: { outcome, quitMs, exitCode, steps, messages, turnEnd }.
//   loaded      a turn stopped, then the quit, the model warm
//   generating  the quit while the turn writes (a generation inside node-llama-cpp's native decode)
//   loading     the quit while the turn loads the model
//   boot-engine (Task 7) a worker started with engineAtBoot on a home whose local model is already active, quit 50 ms
//               after its start: while the engine it started at boot is still being created. The report then holds
//               { outcome, quitMs, exitCode, steps, engine } (engine: the state of its 'engine' event, null if none).
// After the quit, a second worker reads the conversation back: what the stopped turn saved.
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { callWorker, recordAgentEvents } from './worker-events.mts';
import { PERF_LEVERS_ENV } from '../../core/perf-levers.mts';

const { stopWorker } = createRequire(import.meta.url)('../../main.cjs');
const WORKER = fileURLToPath(new URL('../../worker.mjs', import.meta.url));
const STORIES = fileURLToPath(new URL('../fixtures/stories260K.gguf', import.meta.url));
const scenario = process.argv[2] ?? 'loaded';
const capMs = process.argv[3] === undefined ? undefined : Number(process.argv[3]);

/** boot-engine: see the header. */
async function bootEngine(env: NodeJS.ProcessEnv, model: string): Promise<void> {
  // The library entry and the active model are saved by a first worker: the lever reads them at start (ruling F10).
  const setup = new Worker(WORKER, { env });
  const entry = await callWorker(setup, 'gguf-add', { path: model });
  await callWorker(setup, 'save-global-settings', { patch: { active_local_model: entry.id } });
  await stopWorker(setup);
  const worker = new Worker(WORKER, { env: { ...env, [PERF_LEVERS_ENV]: JSON.stringify({ engineAtBoot: true }) }, workerData: { perfLeversAllowed: true } });
  let exitCode: number | null = null;
  const exited = new Promise<void>(resolve => worker.once('exit', code => { exitCode = code; resolve(); }));
  let steps: unknown = null;
  let engine: string | null = null;
  worker.on('message', message => {
    if (message?.type === 'event' && message.event === 'engine') engine = message.state;
    if (typeof message?.id === 'string' && message.id.startsWith('shutdown-') && message.ok) steps = message.result.steps;
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const started = Date.now();
  const outcome = await (capMs === undefined ? stopWorker(worker) : stopWorker(worker, capMs));
  await exited;
  process.stdout.write(`${JSON.stringify({ outcome, quitMs: Date.now() - started, exitCode, steps, engine })}\n`);
}

/** loaded, generating, loading: see the header. */
async function quitDuringTurn(env: NodeJS.ProcessEnv, model: string, home: string, project: string): Promise<void> {
  const worker = new Worker(WORKER, { env });
  let exitCode: number | null = null;
  const exited = new Promise<void>(resolve => worker.once('exit', code => { exitCode = code; resolve(); }));
  let steps: unknown = null;
  worker.on('message', message => { if (typeof message?.id === 'string' && message.id.startsWith('shutdown-') && message.ok) steps = message.result.steps; });
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const rec = recordAgentEvents(worker);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'Once upon a time' });
  if (scenario === 'loading') await rec.first(runId, event => event.kind === 'phase' && event.phase === 'loading');
  else await rec.first(runId, event => event.kind === 'delta');
  if (scenario === 'loaded') {
    await callWorker(worker, 'stop', { runId });
    await rec.until(runId);
  }

  const started = Date.now();
  const outcome = await (capMs === undefined ? stopWorker(worker) : stopWorker(worker, capMs));
  await exited; // a 'timeout' leaves the thread to end by itself, never terminated
  const quitMs = Date.now() - started;

  // What the turn saved, read by a fresh worker on the same home, and the turn log's last line.
  const reader = new Worker(WORKER, { env });
  const messages = await callWorker(reader, 'messages', { folder: project, branchId: 'main' });
  await stopWorker(reader);
  const turnsDir = join(home, 'logs', 'turns');
  const lines: any[] = [];
  for (const name of await readdir(turnsDir).catch(() => [] as string[])) {
    for (const line of (await readFile(join(turnsDir, name), 'utf8')).split('\n')) if (line.trim()) lines.push(JSON.parse(line));
  }
  const turnEnd = lines.filter(line => line.runId === runId && line.event === 'end').at(-1) ?? null;
  process.stdout.write(`${JSON.stringify({ outcome, quitMs, exitCode, steps, messages: messages.map((m: any) => m.role), turnEnd: turnEnd && turnEnd.kind })}\n`);
}

const root = await mkdtemp(join(tmpdir(), 'openagent-quit-'));
try {
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const model = join(root, 'stories260K.gguf');
  await copyFile(STORIES, model);
  const env = { ...process.env, OPENAGENT_HOME: home };

  if (scenario === 'boot-engine') await bootEngine(env, model);
  else await quitDuringTurn(env, model, home, project);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
