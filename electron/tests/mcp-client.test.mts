import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));
const config = (extraEnv: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [FAKE_SERVER],
  env: extraEnv,
});

test('mcpTools discovers real tools from a real stdio child process, as AgentTools', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([config()]);
  assert.deepEqual(errors, []);
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['mcp_boom', 'mcp_echo']);
  const echo = tools.find(t => t.name === 'mcp_echo')!;
  assert.equal(echo.category, 'extension');
  assert.equal(echo.parameters.type, 'object');
  assert.deepEqual((echo.parameters as any).required, ['text']);
});

test('a real tool call round-trips through a real child process and returns the real result', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([config()]);
  const echo = tools.find(t => t.name === 'mcp_echo')!;
  echo.validate({ text: 'bonjour' });
  const result = await echo.execute({ text: 'bonjour' }, new AbortController().signal);
  assert.match(result, /bonjour/);
});

test('a real tool call that the server rejects surfaces the real MCP error message', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([config()]);
  const boom = tools.find(t => t.name === 'mcp_boom')!;
  await assert.rejects(boom.execute({}, new AbortController().signal), /échec volontaire/);
});

test('a server that crashes at startup is isolated: an error is reported, other servers still work', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const crashing = config({ FAKE_MCP_CRASH: '1' });
  const { tools, errors } = await mcpTools([crashing, config()]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(process.execPath.replace(/[\\.]/g, '\\$&')));
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['mcp_boom', 'mcp_echo'], 'the second, healthy server still contributed its tools');
});

test('a server that hangs on discovery times out instead of blocking the whole turn', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const slow = config({ FAKE_MCP_DELAY_MS: '5000' });
  const { tools, errors } = await mcpTools([slow], { discoveryTimeoutMs: 200 });
  assert.equal(tools.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /délai|timeout/i);
});

test('an empty command is refused with a clear error, no process ever spawned', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ command: '', args: [] }]);
  assert.equal(tools.length, 0);
  assert.match(errors[0], /commande/i);
});

test('mcpTools discovers real tools from a real HTTP server (application/json mode)', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ type: 'http', url: fake.url }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(tl => tl.name).sort(), ['mcp_boom', 'mcp_echo']);
});

test('mcpTools discovers real tools from a real HTTP server (text/event-stream mode)', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'sse' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ type: 'sse', url: fake.url }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(tl => tl.name).sort(), ['mcp_boom', 'mcp_echo']);
});

test('mcpTools discovers real tools from a CRLF-framed SSE stream (the official Python SDK\'s framing)', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'sse', lineEnding: '\r\n' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ type: 'http', url: fake.url }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(tl => tl.name).sort(), ['mcp_boom', 'mcp_echo']);
  const result = await tools.find(tl => tl.name === 'mcp_echo')!.execute({ text: 'via CRLF' }, new AbortController().signal);
  assert.equal(result, 'via CRLF');
});

test('a CRLF split across two network chunks still frames the SSE events correctly', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'sse', lineEnding: '\r\n', splitChunks: true });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ type: 'http', url: fake.url }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(tl => tl.name).sort(), ['mcp_boom', 'mcp_echo']);
  const result = await tools.find(tl => tl.name === 'mcp_echo')!.execute({ text: 'coupé' }, new AbortController().signal);
  assert.equal(result, 'coupé');
});

test('a real tool call round-trips over real HTTP and returns the real result', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([{ type: 'http', url: fake.url }]);
  const echo = tools.find(tl => tl.name === 'mcp_echo')!;
  const result = await echo.execute({ text: 'bonjour distant' }, new AbortController().signal);
  assert.match(result, /bonjour distant/);
});

test('a real tool call the remote server rejects surfaces the real MCP error message', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([{ type: 'http', url: fake.url }]);
  const boom = tools.find(tl => tl.name === 'mcp_boom')!;
  await assert.rejects(boom.execute({}, new AbortController().signal), /échec volontaire/);
});

test('the Mcp-Session-Id from initialize is really sent back on the following request', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  await mcpTools([{ type: 'http', url: fake.url }]);
  const toolsListRequest = fake.receivedRequests.find(r => r.message.method === 'tools/list');
  assert.equal(toolsListRequest?.headers['mcp-session-id'], fake.sessionId);
});

test('a configured header (e.g. Authorization) is really received by the remote server', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  await mcpTools([{ type: 'http', url: fake.url, headers: { Authorization: 'Bearer my-real-token' } }]);
  const initRequest = fake.receivedRequests.find(r => r.message.method === 'initialize');
  assert.equal(initRequest?.headers.authorization, 'Bearer my-real-token');
});

test('a remote server with an unreachable URL is isolated: an error is reported, other servers still work', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'json' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const unreachable: any = { type: 'http', url: 'http://127.0.0.1:1/mcp' };
  const { tools, errors } = await mcpTools([unreachable, { type: 'http', url: fake.url }]);
  assert.equal(errors.length, 1);
  assert.deepEqual(tools.map(tl => tl.name).sort(), ['mcp_boom', 'mcp_echo'], 'the working server still discovered its tools');
});

test('a remote server that sends headers but stalls the body times out instead of hanging forever', async t => {
  const { startFakeMcpHttpServer } = await import('./fixtures/fake-mcp-http-server.cjs');
  const fake = await startFakeMcpHttpServer({ mode: 'hang' });
  t.after(() => fake.close());
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ type: 'http', url: fake.url }], { discoveryTimeoutMs: 200 });
  assert.equal(tools.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /délai|timeout/i);
});

test('mcpTools also reports each server\'s own outcome, in config order: the tools it exposed, or why its discovery failed', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const crashed = config({ FAKE_MCP_CRASH: '1' });
  const good = config();
  const empty = { command: '', args: [] };
  const { tools, servers, errors } = await mcpTools([crashed, good, empty]);
  assert.equal(errors.length, 2);
  assert.equal(servers.length, 3, 'one outcome per configured server');
  assert.equal(servers[0].target, crashed);
  assert.equal(servers[0].tools, null);
  assert.match(servers[0].error!, /serveur MCP terminé/);
  assert.equal(servers[1].target, good);
  assert.equal(servers[1].error, null);
  assert.deepEqual(servers[1].tools!.map(tool => tool.name), ['mcp_echo', 'mcp_boom']);
  assert.ok(servers[1].tools!.every(tool => tools.includes(tool)), 'the very tool objects the turn gets, so a caller can tell which server a kept tool came from');
  assert.equal(servers[2].tools, null);
  assert.match(servers[2].error!, /commande absente/);
});

// The kept servers (lever mcpKeepAlive, Task 14). Each test runs the real fixture and reads the PIDs it wrote at start.
async function pidFileIn(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'openagent-mcp-pool-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = join(dir, 'pids.txt');
  const pids = async () => {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(Number); } catch { return []; }
  };
  return { dir, file, pids };
}
function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const toolNames = (tools: { name: string }[]) => tools.map(tool => tool.name).sort();
/** The PIDs `taskkill` was really started for while `action` ran. */
async function taskkillsDuring(action: () => Promise<unknown>): Promise<string[]> {
  const killed: string[] = [];
  const realSpawn = childProcess.spawn;
  (childProcess as any).spawn = (command: string, args: string[], ...rest: unknown[]) => {
    if (command === 'taskkill') killed.push(args[1]);
    return (realSpawn as any)(command, args, ...rest);
  };
  syncBuiltinESMExports();
  try { await action(); } finally {
    (childProcess as any).spawn = realSpawn;
    syncBuiltinESMExports();
  }
  return killed;
}
const pooled = async (t: any, options?: { idleMs?: number }) => {
  const { McpPool } = await import('../core/mcp-client.mts');
  const pool = new McpPool(options);
  t.after(() => pool.closeAll());
  return pool;
};

test('with a pool, two discoveries start the server once', { timeout: 30000 }, async t => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { file, pids } = await pidFileIn(t);
  const pool = await pooled(t);
  const target = config({ FAKE_MCP_PID_FILE: file });
  // Two at once, while the only process is still starting, then one more on the live process.
  const both = await Promise.all([mcpTools([target], { pool }), mcpTools([target], { pool })]);
  for (const { tools, errors } of both) {
    assert.deepEqual(errors, []);
    assert.deepEqual(toolNames(tools), ['mcp_boom', 'mcp_echo']);
  }
  const { tools } = await mcpTools([target], { pool });
  assert.deepEqual(toolNames(tools), ['mcp_boom', 'mcp_echo']);
  const started = await pids();
  assert.equal(started.length, 1, `one process for the three discoveries (pids ${started.join(', ')})`);
  assert.ok(isAlive(started[0]), 'a discovery through the pool leaves the server running');
});

test('a tool call reuses the discovery\'s process', { timeout: 30000 }, async t => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { file, pids } = await pidFileIn(t);
  const pool = await pooled(t);
  const never = new AbortController().signal;
  const { tools } = await mcpTools([config({ FAKE_MCP_PID_FILE: file })], { pool });
  assert.equal(await tools.find(tool => tool.name === 'mcp_echo')!.execute({ text: 'gardé' }, never), 'gardé');
  // The server's own answer that a call failed says nothing about the process: it stays.
  await assert.rejects(tools.find(tool => tool.name === 'mcp_boom')!.execute({}, never), /échec volontaire/);
  const started = await pids();
  assert.equal(started.length, 1, `the calls ran on the discovery's process (pids ${started.join(', ')})`);
  assert.ok(isAlive(started[0]));

  // A kept session was opened under the discovery's timeout: a call has its own, longer one.
  const slow = await pidFileIn(t);
  const slowDiscovered = await mcpTools([config({ FAKE_MCP_PID_FILE: slow.file, FAKE_MCP_CALL_DELAY_MS: '3500' })], { pool, discoveryTimeoutMs: 3000 });
  assert.deepEqual(slowDiscovered.errors, []);
  const slowEcho = slowDiscovered.tools.find(tool => tool.name === 'mcp_echo')!;
  assert.equal(await slowEcho.execute({ text: 'lent' }, never), 'lent');

  // A stopped call ends its process, as it does without a pool: the server must not go on working for nobody.
  const stopping = new AbortController();
  const flight = slowEcho.execute({ text: 'arrêté' }, stopping.signal);
  stopping.abort(new Error('arrêt demandé'));
  await assert.rejects(flight, /arrêt demandé/);
  const [slowPid] = await slow.pids();
  await until(() => !isAlive(slowPid), 'the process of the stopped call gone');
});

test('a crashed server is started again at the next discovery', { timeout: 30000 }, async t => {
  const { mcpTools, stopAllMcpServers } = await import('../core/mcp-client.mts');
  const { dir, file, pids } = await pidFileIn(t);
  const pool = await pooled(t);
  const target = config({ FAKE_MCP_PID_FILE: file, FAKE_MCP_CALL_DELAY_MS: '30000' });
  const { tools } = await mcpTools([target], { pool });
  const echo = tools.find(tool => tool.name === 'mcp_echo')!;

  // A call in flight on the process that dies fails at once, with the reason: it does not wait for its 60 s.
  const flight = echo.execute({ text: 'perdu' }, new AbortController().signal);
  const [first] = await pids();
  process.kill(first);
  await assert.rejects(flight, /serveur MCP terminé/);

  const again = await mcpTools([target], { pool });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(toolNames(again.tools), ['mcp_boom', 'mcp_echo']);
  const [, second, ...others] = await pids();
  assert.deepEqual(others, []);
  assert.ok(isAlive(second), 'the second process is kept in turn');

  // Killed just before a discovery, its exit not yet seen by this process: the discovery still gets a live server.
  process.kill(second);
  const third = await mcpTools([target], { pool });
  assert.deepEqual([third.errors, toolNames(third.tools)], [[], ['mcp_boom', 'mcp_echo']]);
  const after = await pids();
  assert.equal(after.length, 3, `one new process (pids ${after.join(', ')})`);

  // A start that failed is not remembered: the same target works once its script exists.
  const script = join(dir, 'late-server.cjs');
  const late = { command: process.execPath, args: [script], env: { FAKE_MCP_PID_FILE: file } };
  const missing = await mcpTools([late], { pool });
  assert.equal(missing.tools.length, 0);
  assert.match(missing.errors[0], /serveur MCP terminé/);
  await copyFile(FAKE_SERVER, script);
  const found = await mcpTools([late], { pool });
  assert.deepEqual([found.errors, toolNames(found.tools)], [[], ['mcp_boom', 'mcp_echo']]);

  // A process seen to exit leaves the pool at once, and its PID, free for the system to reuse, is never killed.
  const ended = await pool.session(config({ FAKE_MCP_PID_FILE: file, WHICH: 'mort' }), 10000);
  const endedPid = (await pids()).at(-1)!;
  const keptBefore = (pool as any).kept.size;
  process.kill(endedPid);
  await until(() => !ended.alive(), 'its exit seen');
  assert.equal((pool as any).kept.size, keptBefore - 1, 'evicted on exit, not 10 min later');
  const live = await pool.session(config({ FAKE_MCP_PID_FILE: file, WHICH: 'vivant' }), 10000);
  const livePid = (await pids()).at(-1)!;
  const killed = await taskkillsDuring(async () => {
    await ended.close();
    // close and stopAllMcpServers on the same live process, as at quit: one kill.
    await Promise.all([live.close(), stopAllMcpServers()]);
  });
  assert.deepEqual(killed.filter(pid => pid === String(endedPid)), [], 'no kill aimed at an exited process');
  if (process.platform === 'win32') assert.deepEqual(killed.filter(pid => pid === String(livePid)), [String(livePid)], 'one taskkill for the live one');
  assert.ok(!isAlive(livePid));
});

test('a stopped or timed-out request leaves a shared process running while another request is in flight', { timeout: 30000 }, async t => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { file, pids } = await pidFileIn(t);
  const pool = await pooled(t);
  const never = new AbortController().signal;
  // Every answer takes 300 ms and a call 1.2 s more; the fixture handles requests concurrently.
  const target = config({ FAKE_MCP_PID_FILE: file, FAKE_MCP_DELAY_MS: '300', FAKE_MCP_CALL_DELAY_MS: '1200' });
  const { tools, errors } = await mcpTools([target], { pool });
  assert.deepEqual(errors, []);
  const echo = tools.find(tool => tool.name === 'mcp_echo')!;
  const [pid] = await pids();

  const stopping = new AbortController();
  const stopped = echo.execute({ text: 'arrêté' }, stopping.signal);
  const other = echo.execute({ text: 'continue' }, never);
  await new Promise(resolve => setTimeout(resolve, 200)); // Both written: only microtasks separate them from here.
  stopping.abort(new Error('arrêt demandé'));
  await assert.rejects(stopped, /arrêt demandé/);
  assert.equal(await other, 'continue', 'the other call finishes on the shared process');
  assert.ok(isAlive(pid), 'the shared process stays');

  // Another folder's discovery timing out beside a slow call does not end that call either.
  const flight = echo.execute({ text: 'lent' }, never);
  await new Promise(resolve => setTimeout(resolve, 200));
  const timedOut = await mcpTools([target], { pool, discoveryTimeoutMs: 50 });
  assert.match(timedOut.errors[0], /délai dépassé \(tools\/list\)/);
  assert.equal(await flight, 'lent');
  assert.ok(isAlive(pid));
  assert.deepEqual(await pids(), [pid], 'one process throughout');
});

test('closeWhere kills the process', { timeout: 30000 }, async t => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { file, pids } = await pidFileIn(t);
  const pool = await pooled(t);
  const never = new AbortController().signal;
  const removed = config({ FAKE_MCP_PID_FILE: file, WHICH: 'retiré' });
  const other = config({ FAKE_MCP_PID_FILE: file, WHICH: 'autre' });
  const first = await mcpTools([removed], { pool });
  const [removedPid] = await pids();
  await mcpTools([other], { pool });
  const [, otherPid] = await pids();

  await pool.closeWhere(target => (target as typeof removed).env.WHICH === 'retiré');
  assert.ok(!isAlive(removedPid), 'gone when closeWhere returns');
  assert.ok(isAlive(otherPid), 'the other session is untouched');

  // A turn still holding its tools never brings a closed server back: the next discovery alone decides.
  await assert.rejects(first.tools.find(tool => tool.name === 'mcp_echo')!.execute({ text: 'x' }, never), /arrêté/);
  assert.equal((await pids()).length, 2, 'no process started by the refused call');
  const back = await mcpTools([removed], { pool });
  assert.deepEqual(back.errors, []);
  assert.equal((await pids()).length, 3, 'a discovery starts it again');
  assert.equal(await back.tools.find(tool => tool.name === 'mcp_echo')!.execute({ text: 'revenu' }, never), 'revenu');

  // A server closed while it is still starting does not wait for its initialize answer.
  const starting = await pidFileIn(t);
  const opening = pool.session(config({ FAKE_MCP_PID_FILE: starting.file, FAKE_MCP_INIT_DELAY_MS: '60000', WHICH: 'lent' }), 30000);
  await until(async () => (await starting.pids()).length === 1, 'the slow server running');
  await pool.closeWhere(target => (target as typeof removed).env.WHICH === 'lent');
  await assert.rejects(opening, /serveur MCP terminé/);
  assert.ok(!isAlive((await starting.pids())[0]));

  // Unused for idleMs, a session closes by itself.
  const idle = await pidFileIn(t);
  const shortLived = await pooled(t, { idleMs: 150 });
  await mcpTools([config({ FAKE_MCP_PID_FILE: idle.file })], { pool: shortLived });
  const [idlePid] = await idle.pids();
  assert.ok(isAlive(idlePid), 'alive before its idle time');
  await until(() => !isAlive(idlePid), 'the unused session closed');

  // closeAll ends everything, and nothing opens afterwards.
  const running = await pids();
  await pool.closeAll();
  assert.deepEqual(running.filter(isAlive), []);
  await assert.rejects(pool.session(other, 5000), /fermeture/);
  assert.equal((await pids()).length, running.length, 'no process started after closeAll');
});
