const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const result = spawnSync(executable, [join(__dirname, 'trust-visual.cjs')], {
  encoding: 'utf8', timeout: 120000, windowsHide: true, env,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`Electron test process: ${result.error.code}\n`);
// The whole output, kept even when the run is killed (spawnSync returns what was read before ETIMEDOUT).
const runLog = join(tmpdir(), 'openagent-trust-visual-run.log');
writeFileSync(runLog, [
  `status=${result.status} signal=${result.signal} error=${result.error ? result.error.code : 'none'}`,
  '--- stdout ---', result.stdout || '', '--- stderr ---', result.stderr || '',
].join('\n'));
process.stdout.write(`Run log: ${runLog}\n`);
// A killed run printed no FAIL of its own: show where its step log stopped (the test prints the path first thing).
const stepLog = /^Step log: (.+)$/m.exec(result.stdout || '')?.[1]?.trim();
if (result.error && stepLog) {
  try {
    const lines = readFileSync(stepLog, 'utf8').trimEnd().split(/\r?\n/);
    process.stderr.write(`Last ${Math.min(30, lines.length)} steps (${stepLog}):\n${lines.slice(-30).join('\n')}\n`);
  } catch (error) {
    process.stderr.write(`(step log unreadable: ${error.message})\n`);
  }
}
process.exit(result.status === 0 && result.stdout?.includes('PASS trust banner') ? 0 : 1);
