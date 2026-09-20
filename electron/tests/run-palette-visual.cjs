const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const result = spawnSync(executable, [join(__dirname, 'palette-visual.cjs')], {
  encoding: 'utf8', timeout: 150000, windowsHide: true, env,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`Electron test process: ${result.error.code}\n`);
process.exit(result.status === 0 && result.stdout?.includes('PASS command palette') ? 0 : 1);
