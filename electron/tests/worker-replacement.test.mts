// Re-placement between turns on the real worker (final fix wave, item 4): it starts only after a turn, says so through
// the 'model' event and model-status (`replacing`), and a send cancels it at once, the turn running on the model still
// loaded. The decision rule itself is pure (tests/replacement.test.mts); here the test seam workerData.testReplacement
// forces it (`force`) and holds the reload (`delayMs`), standing for a long native load. Real worker, stories260K only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { callWorker, recordAgentEvents } from './support/worker-events.mts';

const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));
const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));

async function start(t: { after(fn: () => unknown): void }, testReplacement: { force: boolean; delayMs?: number; checkDelayMs?: number; sendDelayMs?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-replacement-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const model = join(root, 'stories260K.gguf');
  await copyFile(STORIES, model);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home }, workerData: { testReplacement }, stdout: true, stderr: true });
  terminateAtEnd(t, worker);
  let log = '';
  worker.stdout.on('data', chunk => { log += String(chunk); });
  worker.stderr.on('data', chunk => { log += String(chunk); });
  const models: any[] = [];
  worker.on('message', message => { if (message?.type === 'event' && message.event === 'model') models.push(message); });
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  return { worker, project, rec, models, log: () => log };
}

/** One turn, stopped at its first word (stories260K would otherwise write up to the output cap). */
async function stoppedTurn(worker: Worker, rec: ReturnType<typeof recordAgentEvents>, project: string): Promise<any[]> {
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'Once upon a time' });
  await rec.first(runId, event => event.kind === 'delta', 120000);
  await callWorker(worker, 'stop', { runId });
  const events = await rec.until(runId);
  assert.equal(events.at(-1).kind, 'stopped', JSON.stringify(events.map(event => event.kind)));
  return events;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('after a turn, a re-placement reloads the model in the background, shown as « replacing » until it ends', { timeout: 180000 }, async t => {
  const { worker, project, rec, models, log } = await start(t, { force: true });
  await stoppedTurn(worker, rec, project);
  const began = await waitFor(() => models.find(event => event.replacing === true), 30000, 'replacing: true');
  assert.equal(began.loaded, true);
  await waitFor(() => models.slice(models.indexOf(began) + 1).find(event => event.replacing === undefined), 60000, 'the end of the re-placement');
  await waitFor(() => (log().includes('réallocation terminée') ? true : undefined), 10000, 'the end line in the app log');
  assert.match(log(), /\[placement\] réallocation sur la carte : forcée par le test/);
  const status = await callWorker(worker, 'model-status', {});
  assert.equal(status.loaded, true, 'reloaded and warm');
  assert.equal(status.replacing, undefined);
});

test('a send during a re-placement cancels it at once, and the turn runs on the model still loaded', { timeout: 180000 }, async t => {
  const { worker, project, rec, models, log } = await start(t, { force: true, delayMs: 60000 });
  await stoppedTurn(worker, rec, project);
  await waitFor(() => models.find(event => event.replacing === true), 30000, 'replacing: true');
  assert.equal((await callWorker(worker, 'model-status', {})).replacing, true, 'model-status says it too');
  const sentAt = Date.now();
  const second = await stoppedTurn(worker, rec, project);
  assert.ok(Date.now() - sentAt < 50000, 'the turn did not wait for the held re-placement');
  assert.match(log(), /réallocation annulée/);
  assert.doesNotMatch(log(), /réallocation terminée/);
  assert.equal(second.some(event => event.kind === 'phase' && event.phase === 'loading'), false,
    `no load: the warm model ran the turn (${second.filter(event => event.kind === 'phase').map(event => event.phase)})`);
});

test('a re-placement whose VRAM read ends while a send is between its checks and its run does not start', { timeout: 180000 }, async t => {
  // The window, held: the check ends 1 s after the turn, the send sits 4 s between cancelReplacement and its run.
  const { worker, project, rec, models, log } = await start(t, { force: true, delayMs: 60000, checkDelayMs: 1000, sendDelayMs: 4000 });
  const first = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'Once upon a time' });
  await rec.first(first.runId, event => event.kind === 'delta', 120000);
  await callWorker(worker, 'stop', { runId: first.runId });
  await rec.until(first.runId);
  // Racing the held re-placement of the first turn: its check ends inside this send's window.
  const sentAt = Date.now();
  const second = await stoppedTurn(worker, rec, project);
  assert.ok(Date.now() - sentAt < 50000, 'the turn did not queue behind a reload');
  assert.doesNotMatch(log(), /réallocation sur la carte/, 'no re-placement started under the pending send');
  assert.equal(models.some(event => event.replacing === true), false);
  assert.equal(second.some(event => event.kind === 'phase' && event.phase === 'loading'), false);
});
