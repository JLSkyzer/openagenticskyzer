import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runProcess } = await import('../core/process.mts');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const node = (script: string) => [process.execPath, ['-e', script]] as const;

// The parent starts a grandchild that would write MARKER after 1.5 s, then idles. Killing only
// the direct child (what Python's process.kill() did) leaves the grandchild alive to write it.
const WITH_GRANDCHILD = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'alive'), 1500)"], { stdio: 'ignore' });
  setTimeout(() => {}, 60000);
`;

async function scratch(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'openagent-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, marker: join(dir, 'alive.txt') };
}

test('runProcess captures stdout, stderr and the exit code without throwing on failure', async () => {
  const [cmd, args] = node(`process.stdout.write('out'); process.stderr.write('err'); process.exit(3)`);
  const result = await runProcess(cmd, [...args], { timeout: 10000 });
  assert.deepEqual({ stdout: result.stdout, stderr: result.stderr, code: result.code, timedOut: result.timedOut }, { stdout: 'out', stderr: 'err', code: 3, timedOut: false });
});

test('runProcess passes the given environment and working directory', async t => {
  const { dir } = await scratch(t);
  const [cmd, args] = node(`process.stdout.write(process.env.PROBE + '|' + process.cwd())`);
  const result = await runProcess(cmd, [...args], { cwd: dir, env: { ...process.env, PROBE: 'visible' }, timeout: 10000 });
  assert.match(result.stdout, /^visible\|/);
  assert.ok(result.stdout.toLowerCase().endsWith(dir.toLowerCase().replace(/^.*[\\/]/, '')), 'ran in the requested directory');
});

test('a timeout kills the whole process tree, not just the direct child', async t => {
  const { marker } = await scratch(t);
  const [cmd, args] = node(WITH_GRANDCHILD);
  const started = Date.now();
  const result = await runProcess(cmd, [...args], { env: { ...process.env, MARKER: marker }, timeout: 400 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000, 'returned promptly after the timeout');
  await sleep(2500);
  await assert.rejects(stat(marker), 'the grandchild was killed, so it never wrote its marker');
});

test('aborting the signal kills the whole tree and rejects with the abort reason', async t => {
  const { marker } = await scratch(t);
  const [cmd, args] = node(WITH_GRANDCHILD);
  const controller = new AbortController();
  const running = runProcess(cmd, [...args], { env: { ...process.env, MARKER: marker }, timeout: 30000, signal: controller.signal });
  await sleep(300);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  await sleep(2500);
  await assert.rejects(stat(marker), 'the grandchild was killed on abort too');
});

test('an already aborted signal never starts the process', async () => {
  const controller = new AbortController();
  controller.abort();
  const [cmd, args] = node(`process.exit(0)`);
  await assert.rejects(runProcess(cmd, [...args], { timeout: 10000, signal: controller.signal }), { name: 'AbortError' });
});

test('output beyond the cap is dropped and reported, without blocking the child', async () => {
  const [cmd, args] = node(`process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.stderr.write('e'.repeat(3 * 1024 * 1024))`);
  const result = await runProcess(cmd, [...args], { timeout: 20000, maxBytes: 1000 });
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.stderr.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.code, 0, 'the child finished normally, its pipe was drained');
});

test('a command that does not exist rejects with ENOENT instead of hanging', async () => {
  await assert.rejects(runProcess('definitely-not-a-command-xyz', [], { timeout: 5000 }), { code: 'ENOENT' });
});
