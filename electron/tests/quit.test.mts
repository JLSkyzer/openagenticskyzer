// Quitting the app (final fix wave, item 7) on a real worker with stories260K, each quit in a child process
// (tests/support/quit-child.mts): ending the worker thread during a native call crashes the whole process, which
// would take the test runner with it.
// - The crash repro: the quit lands while the turn's generation is inside node-llama-cpp, and main gives up waiting at
//   once (cap 0, standing for a 27B whose decode batch outlasts main's old 3 s grace). Before the fix, main then
//   terminated the thread: 0xC0000409, 5 in 5. Now the thread is never ended from outside; it ends itself once the
//   native call returned.
// - The time to quit, at three moments (model warm, during a generation, during the load), with the conversation the
//   stopped turn saved and its turn log closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./support/quit-child.mts', import.meta.url));
// What a native crash looks like from the parent: STATUS_STACK_BUFFER_OVERRUN.
const NATIVE_CRASH = 0xC0000409;
// stories260K quits in tens of milliseconds (measured: 1–25 ms warm or generating, about 0.7 s during the load, which
// waits for the Llama's creation). The bound leaves room for a loaded machine, far below the old 3 s grace + terminate.
const QUIT_BOUND_MS = 5000;

function quit(scenario: string, capMs?: number) {
  const args = ['--experimental-strip-types', '--no-warnings', CHILD, scenario, ...(capMs === undefined ? [] : [String(capMs)])];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 170000 });
  const status = child.status ?? -1;
  const lines = (child.stdout ?? '').trim().split('\n');
  let report: any = null;
  try { report = JSON.parse(lines.at(-1) ?? ''); } catch { /* no report: the process died first */ }
  return { status, report, output: `${child.stdout}\n${child.stderr}`.slice(-2000) };
}

test('the crash repro: a quit that stops waiting during a generation no longer crashes, and the thread ends by itself', { timeout: 180000 }, () => {
  const { status, report, output } = quit('generating', 0);
  assert.notEqual(status >>> 0, NATIVE_CRASH, `native crash 0xC0000409:\n${output}`);
  assert.equal(status, 0, output);
  assert.equal(report.outcome, 'timeout', 'main stopped waiting at once');
  assert.equal(report.exitCode, 0, 'the worker ended itself (process.exit(0)), it was not terminated (exit code 1)');
  assert.deepEqual(report.messages, ['user', 'assistant'], 'the stopped turn saved its message and its partial reply');
  assert.equal(report.turnEnd, 'stopped', 'its turn log is closed');
});

for (const scenario of ['loaded', 'generating', 'loading']) {
  test(`the time to quit, ${scenario}: under ${QUIT_BOUND_MS} ms, the worker ending by itself, nothing lost`, { timeout: 180000 }, t => {
    const { status, report, output } = quit(scenario);
    assert.equal(status, 0, output);
    t.diagnostic(`${scenario}: quit ${report.quitMs} ms, steps ${JSON.stringify(report.steps)}`);
    assert.equal(report.outcome, 'exited');
    assert.equal(report.exitCode, 0, 'ended by itself');
    assert.ok(report.quitMs < QUIT_BOUND_MS, `quit took ${report.quitMs} ms`);
    assert.equal(report.steps.total <= report.quitMs, true);
    assert.equal(report.turnEnd, 'stopped', 'the turn log is closed');
    assert.equal(report.messages[0], 'user', 'the conversation is saved');
  });
}
