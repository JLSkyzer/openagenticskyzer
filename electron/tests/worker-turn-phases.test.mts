// The phases a turn posts, a stop that answers at once, and the turn's timing on done, stopped and the saved reply:
// on the real worker, with the real stories260K .gguf (tests 1-4) or the scripted provider (test 5, a tool turn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { testWorkerOptions } from './support/test-model-provider.mts';
import { withTrainContext } from './support/gguf-fixture.mts';
import { callWorker, recordAgentEvents, phasesOf } from './support/worker-events.mts';
import { PERF_LEVERS_ENV } from '../core/perf-levers.mts';
import { turnLogDir } from '../core/turn-log.mts';

const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));
const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const FAKE_MCP_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));

/** A real worker on a temp home, stories260K copied and activated as in worker-local-model.test.mts::setup.
 * `trainContext`: the copy's train context is rewritten (a bigger context, a slower creation). */
async function setup(t: { after(fn: () => unknown): void }, options: { trainContext?: number; localContext?: number | 'max' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-turn-phases-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const model = join(root, 'stories260K.gguf');
  if (options.trainContext) await withTrainContext(STORIES, model, options.trainContext);
  else await copyFile(STORIES, model);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id, ...(options.localContext ? { local_context: options.localContext } : {}) } });
  return { worker, folder };
}

/** The event list for a failure message (lesson 2026-09-20): each event's kind and phase fields, runs of deltas
 * collapsed into one entry with their count. */
function dump(events: readonly any[]): string {
  const rows: any[] = [];
  for (const { kind, phase, progress, tool, message } of events) {
    const last = rows.at(-1);
    if (kind === 'delta' && last?.kind === 'delta') { last.count++; continue; }
    rows.push({ kind, phase, progress, tool, message: typeof message === 'string' ? message : undefined, ...(kind === 'delta' ? { count: 1 } : {}) });
  }
  return JSON.stringify(rows);
}

test('1. a stories260K turn: preparing → loading → reading → writing, then done with its timing, saved on the reply', { timeout: 180000 }, async t => {
  const { worker, folder } = await setup(t);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  const events = await rec.until(runId, { timeoutMs: 170000 });
  const done = events.at(-1);
  assert.equal(done.kind, 'done', dump(events));
  assert.deepEqual(phasesOf(events), ['preparing', 'loading', 'reading', 'writing'], dump(events));
  // Ruling M10: only the loading events that carry a progress are ordered; the first one (the load start) has none.
  const progress = events.filter(e => e.kind === 'phase' && e.phase === 'loading' && 'progress' in e).map(e => e.progress);
  assert.ok(progress.length > 0, dump(events));
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], `progress goes back: ${progress.join(',')}`);
  assert.equal(progress.at(-1), 100, `the last progress: ${progress.join(',')}`);
  assert.ok(progress.every(p => Number.isInteger(p) && p >= 0 && p <= 100), progress.join(','));
  const { timing } = done;
  assert.ok(timing.loadMs > 0, JSON.stringify(timing));
  assert.ok(timing.readMs >= 0, JSON.stringify(timing));
  assert.ok(timing.firstTextMs > 0, JSON.stringify(timing));
  assert.ok(timing.totalMs >= timing.firstTextMs, JSON.stringify(timing));
  assert.ok(timing.outputTokens > 0, JSON.stringify(timing));
  assert.ok(timing.tokensPerSecond > 0, JSON.stringify(timing));
  assert.equal(events.some(e => e.kind === 'stats'), false, 'stats are the worker\'s own, never posted');
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.deepEqual(saved[1].timing, done.timing);
});

test('2. a stop during writing: stopping at once, stopped with timing, the partial reply saved with it; latency measured', { timeout: 180000 }, async t => {
  const { worker, folder } = await setup(t);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  await rec.first(runId, e => e.kind === 'delta', 170000);
  const t0 = Date.now();
  const stop = callWorker(worker, 'stop', { runId });
  const events = await rec.until(runId);
  const latency = Date.now() - t0;
  await stop;
  t.diagnostic(`stop latency ${latency} ms`);
  const stopped = events.at(-1);
  assert.equal(stopped.kind, 'stopped', dump(events));
  assert.deepEqual(phasesOf(events).slice(-2), ['writing', 'stopping'], dump(events));
  const stoppingAt = events.findIndex(e => e.kind === 'phase' && e.phase === 'stopping');
  assert.ok(stoppingAt !== -1 && stoppingAt < events.length - 1, 'stopping comes before stopped');
  assert.ok(stopped.timing.firstTextMs > 0, JSON.stringify(stopped.timing));
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.equal(saved.length, 2, JSON.stringify(saved));
  assert.equal(saved[1].role, 'assistant');
  assert.ok(saved[1].content.length > 0, 'the partial reply is kept');
  assert.deepEqual(saved[1].timing, stopped.timing);
  assert.ok(latency < 5000, `stop latency ${latency} ms`);
});

test('3. a stop during the load abandons it: no reading, nothing loaded afterwards', { timeout: 180000 }, async t => {
  const { worker, folder } = await setup(t, { trainContext: 131072, localContext: 'max' });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  await rec.first(runId, e => e.kind === 'phase' && e.phase === 'loading', 170000);
  const stop = callWorker(worker, 'stop', { runId });
  const events = await rec.until(runId);
  await stop;
  const stopped = events.at(-1);
  assert.equal(stopped.kind, 'stopped', dump(events));
  const phases = phasesOf(events);
  assert.ok(phases.includes('loading'), dump(events));
  assert.equal(phases.at(-1), 'stopping', dump(events));
  assert.equal(phases.includes('reading'), false, dump(events));
  assert.equal(Object.hasOwn(stopped.timing, 'readMs'), false, JSON.stringify(stopped.timing));
  assert.equal(Object.hasOwn(stopped.timing, 'loadMs'), false, JSON.stringify(stopped.timing));
  // The stop releases the turn at once (untilAborted), while the native load goes on behind it until it sees its
  // signal: read right after `stopped`, model-status would say « not loaded » whether or not the engine honours the
  // stop. So it is read over SETTLE_MS, about ten times this copy's cold load (≈1.1 s measured on 2026-10-22, send →
  // reading with nothing stopped), long after any load the stop failed to cut would have ended and stayed warm.
  const SETTLE_MS = 10_000;
  for (const end = Date.now() + SETTLE_MS; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 250))) {
    assert.equal((await callWorker(worker, 'model-status')).loaded, false, 'a load the stop cut short never stays loaded');
  }
  const saved = await callWorker(worker, 'messages', { folder, branchId: 'main' });
  assert.deepEqual(saved, [{ role: 'user', content: 'Once upon a time' }]);
});

test('4. a stop right after the send, while preparing: stopped, the model never loads', { timeout: 60000 }, async t => {
  const { worker, folder } = await setup(t);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  const stop = callWorker(worker, 'stop', { runId });
  const events = await rec.until(runId, { timeoutMs: 50000 });
  await stop;
  assert.equal(events.at(-1).kind, 'stopped', dump(events));
  const phases = phasesOf(events);
  assert.equal(phases.at(-1), 'stopping', dump(events));
  assert.equal(phases.includes('reading'), false, dump(events));
  assert.equal((await callWorker(worker, 'model-status')).loaded, false);
});

/** SSE frames, as test-model-provider.mts::read parses them. */
const sse = (chunks: readonly unknown[]) => [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');

test('5. with the scripted provider, a tool turn: preparing → reading → tool → reading → writing; the tool phase names the tool', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-turn-phases-tool-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const step = requests;
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(step === 1
        ? sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'notes.md', content: 'salut' }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
        : sse([
          { choices: [{ delta: { content: 'Fichier ' } }] },
          { choices: [{ delta: { content: 'créé.' }, finish_reason: 'stop' }] },
        ]));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const worker = new Worker(WORKER, testWorkerOptions(home));
  terminateAtEnd(t, worker);
  // Ruling S4: create_file is a write tool, asked by default — the prompt would hang this test.
  await callWorker(worker, 'save-global-settings', { patch: { files_ask: false } });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'crée notes.md', testModel: { base_url: `http://127.0.0.1:${port}/v1`, model: 'm' } });
  const events = await rec.until(runId, { timeoutMs: 25000 });
  const done = events.at(-1);
  assert.equal(done.kind, 'done', dump(events));
  assert.deepEqual(phasesOf(events), ['preparing', 'reading', 'tool', 'reading', 'writing'], dump(events));
  assert.equal(events.find(e => e.kind === 'phase' && e.phase === 'tool').tool, 'create_file');
  assert.equal(typeof done.timing.firstTextMs, 'number', JSON.stringify(done.timing));
  assert.equal(Object.hasOwn(done.timing, 'outputTokens'), false, 'the scripted provider reports no stats');
  const saved = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(saved.at(-1).timing, done.timing);
});

/** Every turn log line of `home`, in order. */
async function logLines(home: string): Promise<any[]> {
  const dir = turnLogDir(home);
  const names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  return (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Task 7, lever overlapLoad: the model loads while the turn's tools are prepared. A global MCP server (the fake one, as
// worker-mcp.test.mts writes it in mcp.json) answers its initialize after 1.5 s, which today holds « preparing » that
// long before the load. The durations are the worker's own: a phase line's `previousMs` (its `at` is the time the line
// was written, and lines before the log opens are written together once registerTools has returned).
test('6. with overlapLoad, the load starts while the tools are still being prepared (a 1.5 s MCP server)', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-turn-phases-overlap-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const model = join(root, 'stories260K.gguf');
  await copyFile(STORIES, model);
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'lent', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_INIT_DELAY_MS: '1500' }, added_at: new Date().toISOString() }]));
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home, [PERF_LEVERS_ENV]: JSON.stringify({ overlapLoad: true }) }, workerData: { perfLeversAllowed: true } });
  terminateAtEnd(t, worker);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
  const events = await rec.until(runId, { timeoutMs: 110000 });
  assert.equal(events.at(-1).kind, 'done', dump(events));
  assert.deepEqual(phasesOf(events), ['preparing', 'loading', 'reading', 'writing'], dump(events));
  const phases = (await logLines(home)).filter(line => line.runId === runId && line.event === 'phase');
  const loading = phases.find(line => line.phase === 'loading');
  const reading = phases.find(line => line.phase === 'reading');
  assert.ok(loading.previousMs < 1000, `loading started ${loading.previousMs} ms after the turn, before the MCP server answered`);
  // Not vacuous: the turn did wait for the MCP server, inside « loading ».
  assert.ok(reading.previousMs >= 1000, `loading lasted ${reading.previousMs} ms: the MCP server's 1.5 s should fall in it`);
});
