const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
// The first hardware-info creates the engine's Llama (a GPU probe): allow it well beyond a plain settings test.
const result = spawnSync(executable, [join(__dirname, 'hardware-visual.cjs')], {
  encoding: 'utf8', timeout: 240000, windowsHide: true, env,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`Electron test process: ${result.error.code}\n`);
process.exit(result.status === 0 && result.stdout?.includes('PASS hardware tab') ? 0 : 1);
