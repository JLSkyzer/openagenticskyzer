// The turn log on the real worker (core/turn-log.mts wired in worker.mjs::runSend): no secret reaches it, a real
// stories260K turn stopped while writing logs its model, its generation and the stop latency, the levels and the
// retention apply, and a migrated data home receives nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { testWorkerOptions } from './support/test-model-provider.mts';
import { callWorker, recordAgentEvents } from './support/worker-events.mts';
import { turnLogDir, SENSITIVE_FILE_MASK } from '../core/turn-log.mts';

const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));
const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));

/** SSE frames, as test-model-provider.mts::read parses them. */
const sse = (chunks: readonly unknown[]) => [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');
const textReply = (text: string) => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);

/** A scripted model on loopback: the n-th request gets replies[n] (the last one repeated). */
async function scripted(t: { after(fn: () => unknown): void }, replies: readonly string[]): Promise<{ base_url: string; model: string }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    const body = replies[Math.min(requests++, replies.length - 1)];
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  return { base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'm' };
}

/** A loopback port nothing listens on (lesson 2026-10-02: listen on port 0, then close). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function dirs(t: { after(fn: () => unknown): void }, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  return { root, home, project };
}

/** Every day file's text, concatenated (a turn across midnight writes two). */
async function logText(home: string): Promise<string> {
  const dir = turnLogDir(home);
  if (!existsSync(dir)) return '';
  const names = (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  return (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('');
}
const logLines = async (home: string) => (await logText(home)).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('1. no secret reaches the turn log: typed, answered, in tool arguments, in MCP config, in a sensitive file', { timeout: 60000 }, async t => {
  const { home, project } = await dirs(t, 'openagent-turn-log-secrets-');
  const port = await closedPort();
  const addedAt = new Date().toISOString();
  await writeFile(join(home, 'mcp.json'), JSON.stringify([
    { id: 'stdio-1', command: process.execPath, args: ['-e', ''], env: { API_KEY: 'mcp-env-secret-4242' }, added_at: addedAt },
    { id: 'remote-1', type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer mcp-header-secret-4242' }, added_at: addedAt },
  ]));
  await writeFile(join(project, 'secrets.json'), '{"k":"file-secret-4242"}');
  const hfToken = 'hf_' + 'Z9'.repeat(17);
  const githubPat = 'github_pat_' + 'e'.repeat(30);
  const ghp = 'ghp_' + 'q'.repeat(36);
  const sk = 'sk-' + 'w'.repeat(40);
  const testModel = await scripted(t, [
    sse([
      { choices: [{ delta: { content: `voici ${ghp}` } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'secrets.json' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    textReply(sk),
  ]);
  const worker = new Worker(WORKER, testWorkerOptions(home));
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { hf_token: hfToken } });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const text = `mon jeton ${hfToken}, ${githubPat}, mcp-env-secret-4242 et mcp-header-secret-4242`;
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text, testModel });
  const events = await rec.until(runId, { timeoutMs: 50000 });
  assert.equal(events.at(-1).kind, 'done', JSON.stringify(events.map(e => e.kind)));

  const raw = await logText(home);
  assert.ok(raw.length > 0, 'the day file exists');
  for (const secret of [hfToken, 'Z9'.repeat(17), githubPat, 'mcp-env-secret-4242', 'mcp-header-secret-4242', 'file-secret-4242', ghp, sk]) {
    assert.ok(!raw.includes(secret), `${secret} reached the turn log`);
  }
  const lines = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const tool = lines.find(line => line.event === 'tool' && line.tool === 'read_file');
  assert.ok(tool, JSON.stringify(lines.map(line => line.event)));
  assert.equal(tool.result, SENSITIVE_FILE_MASK);
  assert.deepEqual(tool.arguments, { path: 'secrets.json' });
  const kinds = new Set(lines.map(line => line.event));
  for (const kind of ['turn-start', 'phase', 'tool', 'reply', 'end']) assert.ok(kinds.has(kind), `${kind} missing: ${[...kinds]}`);
  assert.equal(lines[0].event, 'turn-start');
  assert.equal(lines.at(-1).event, 'end');
  assert.equal(lines.at(-1).kind, 'done');
  assert.ok(lines.every(line => line.runId === runId && line.folder === project));
});

test('2. a stories260K turn stopped while writing logs model-ready, generation and the stop latency', { timeout: 180000 }, async t => {
  const { root, home, project } = await dirs(t, 'openagent-turn-log-stories-');
  const model = join(root, 'stories260K.gguf');
  await copyFile(STORIES, model);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const entry = await callWorker(worker, 'gguf-add', { path: model });
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: entry.id } });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'Once upon a time' });
  await rec.first(runId, e => e.kind === 'delta', 170000);
  const stop = callWorker(worker, 'stop', { runId });
  const events = await rec.until(runId);
  await stop;
  const stopped = events.at(-1);
  assert.equal(stopped.kind, 'stopped', JSON.stringify(events.map(e => e.kind)));

  const lines = await logLines(home);
  const ready = lines.find(line => line.event === 'model-ready');
  assert.ok(ready, JSON.stringify(lines.map(line => line.event)));
  assert.ok(['cuda', 'vulkan', 'metal', 'cpu'].includes(ready.backend), JSON.stringify(ready));
  assert.equal(ready.contextSize, 16384, JSON.stringify(ready));
  assert.equal(typeof ready.wrapper, 'string');
  assert.ok(ready.wrapper.length > 0, JSON.stringify(ready));
  assert.equal(ready.opensThought, false, 'stories260K has no think: no reply starts as reasoning (Task 5b)');
  assert.ok(ready.loadMs > 0, JSON.stringify(ready));
  assert.equal(ready.placement, 'direct', 'placed as node-llama-cpp chose: no step-down, no fallback');
  assert.equal(Object.hasOwn(ready, 'placementNote'), false);
  // The load's progress is logged in steps of 10 % (the page still gets every percent): about 100 lines per load before.
  const progress = lines.filter(line => line.event === 'phase' && line.phase === 'loading' && line.progress !== undefined);
  assert.ok(progress.length <= 11, `${progress.length} progress lines: ${progress.map(line => line.progress)}`);
  assert.ok(progress.every(line => line.progress % 10 === 0), progress.map(line => line.progress).join(','));
  const generation = lines.find(line => line.event === 'generation');
  assert.ok(generation, JSON.stringify(lines.map(line => line.event)));
  assert.ok(generation.inputTokens > 0 && generation.outputTokens > 0, JSON.stringify(generation));
  const end = lines.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.kind, 'stopped');
  assert.equal(typeof end.stopLatencyMs, 'number');
  assert.ok(end.stopLatencyMs >= 0, JSON.stringify(end));
  assert.deepEqual(end.timing, stopped.timing);
  const stopping = lines.find(line => line.event === 'phase' && line.phase === 'stopping');
  assert.ok(stopping, 'the stop op\'s « stopping » is logged too (ruling M7)');
  assert.equal(stopping.previous, 'writing');
  assert.ok(stopping.previousMs >= 0);
  t.diagnostic(`stop latency logged: ${end.stopLatencyMs} ms`);
});

test('3. turn_log metadata keeps no content; off writes no file; an expired day file is pruned at worker start', { timeout: 60000 }, async t => {
  const { home, project } = await dirs(t, 'openagent-turn-log-levels-');
  await mkdir(turnLogDir(home), { recursive: true });
  const expired = join(turnLogDir(home), '2000-01-01.jsonl');
  await writeFile(expired, '{}\n');
  const testModel = await scripted(t, [textReply('une réponse')]);
  const worker = new Worker(WORKER, testWorkerOptions(home));
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { turn_log: 'metadata' } });
  assert.equal(existsSync(expired), false, 'pruned before the first op is answered');
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());

  const first = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'contenu tapé', testModel });
  assert.equal((await rec.until(first.runId, { timeoutMs: 25000 })).at(-1).kind, 'done');
  const lines = await logLines(home);
  assert.ok(lines.some(line => line.event === 'reply'), JSON.stringify(lines.map(line => line.event)));
  for (const line of lines) {
    for (const key of ['text', 'reasoning', 'arguments', 'result']) assert.equal(Object.hasOwn(line, key), false, JSON.stringify(line));
  }
  assert.ok(!(await logText(home)).includes('contenu tapé'));
  assert.ok(!(await logText(home)).includes('une réponse'));

  await callWorker(worker, 'save-global-settings', { patch: { turn_log: 'off' } });
  const second = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'encore', testModel });
  assert.equal((await rec.until(second.runId, { timeoutMs: 25000 })).at(-1).kind, 'done');
  assert.equal((await logLines(home)).length, lines.length, 'off adds no line');
});

test('4. after a data-folder migration, a turn writes nothing into the old home', { timeout: 60000 }, async t => {
  const { root, home, project } = await dirs(t, 'openagent-turn-log-migrated-');
  const newDir = join(root, 'new-data-home');
  const testModel = await scripted(t, [textReply('après la migration')]);
  const worker = new Worker(WORKER, testWorkerOptions(home));
  terminateAtEnd(t, worker);
  const result = await callWorker(worker, 'migrate-data-dir', { newDir });
  assert.deepEqual(result.errors, []);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', testModel });
  assert.equal((await rec.until(runId, { timeoutMs: 50000 })).at(-1).kind, 'done');
  assert.deepEqual(await readdir(home), ['redirect.json']);
  assert.equal(existsSync(turnLogDir(newDir)), false, 'nor into the new one before the restart');
});

test('5. a migration to the data folder it already is moves nothing: the turn log goes on', { timeout: 60000 }, async t => {
  const { home, project } = await dirs(t, 'openagent-turn-log-same-home-');
  const testModel = await scripted(t, [textReply('toujours là')]);
  const worker = new Worker(WORKER, testWorkerOptions(home));
  terminateAtEnd(t, worker);
  const result = await callWorker(worker, 'migrate-data-dir', { newDir: home });
  assert.deepEqual(result, { moved: 0, errors: [] });
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', testModel });
  assert.equal((await rec.until(runId, { timeoutMs: 50000 })).at(-1).kind, 'done');
  const lines = await logLines(home);
  assert.ok(lines.some(line => line.runId === runId && line.event === 'end'), 'the turn was logged: nothing moved, so the log was not suspended (M-g)');
});
