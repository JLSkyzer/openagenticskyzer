// Launches tests/restart-app.cjs with Electron (no window) and checks, from its synchronous log, that the 'restart-app'
// op answered, that the app quit through 'before-quit' then 'will-quit', and that a NEW instance (another pid) of that
// same test script started after it. Everything lives in one temp folder, removed once the second instance is gone.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const root = mkdtempSync(join(tmpdir(), 'openagent-restart-app-'));
const log = join(root, 'restart.log');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  const first = spawnSync(executable, [join(__dirname, 'restart-app.cjs'), `--restart-log=${log}`], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env,
  });
  process.stdout.write(first.stdout || '');
  process.stderr.write(first.stderr || '');
  if (first.error) throw new Error(`first instance: ${first.error.code}`);
  const deadline = Date.now() + 20000;
  while (!/^relaunched pid=\d+$/m.test(read()) && Date.now() < deadline) await pause(200);
  const lines = read().trim().split(/\r?\n/);
  process.stdout.write(`restart log:\n${lines.map(line => `  ${line}`).join('\n')}\n`);
  const firstPid = Number(/^first pid=(\d+)$/m.exec(read())?.[1]);
  const secondPid = Number(/^relaunched pid=(\d+)$/m.exec(read())?.[1]);
  const expected = ['first', 'answer {"restarting":true}', 'before-quit', 'will-quit', 'relaunched'];
  const seen = lines.map(line => line.replace(/ pid=\d+$/, ''));
  if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error(`expected the sequence ${JSON.stringify(expected)}, got ${JSON.stringify(seen)}`);
  if (first.status !== 0) throw new Error(`the first instance exited with ${first.status}`);
  if (!secondPid || secondPid === firstPid) throw new Error('no new instance was started');
  const gone = Date.now() + 10000;
  while (alive(secondPid) && Date.now() < gone) await pause(200);
  if (alive(secondPid)) throw new Error(`the relaunched instance (pid ${secondPid}) is still running`);
  process.stdout.write(`PASS restart-app: the op answered, the app quit through before-quit and will-quit, and a new instance (pid ${secondPid}, was ${firstPid}) started after it\n`);
})().then(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
}, error => {
  process.stderr.write(`FAIL restart-app: ${error.message}\nKept for inspection: ${root}\n`);
  process.exit(1);
});
