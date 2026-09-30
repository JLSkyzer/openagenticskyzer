// Run with Electron, not node. Proves the "Outils" tab's read-only Plugins section end to end
// through the REAL UI and the REAL worker.mjs plugin-list op (a real .mjs file on disk, really
// imported). The deeper proof — a real agent turn actually calling a real plugin tool — already
// exists at the worker level in tests/worker-plugin.test.mts; this visual test does not repeat
// that here, only the UI plumbing around the list + error display.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-plugin-visual-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'good.mjs'), `export function getTools() { return [{ name: 'greet_plugin', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);
  await writeFile(join(home, 'tools', 'broken.mjs'), `export const notGetTools = true;`);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  const screenshotDir = process.env.OPENAGENT_PLUGIN_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'connection-snapshot') {
        return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id });
      });
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)}))?.click()`);

    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
    await enter('alpha');
    await waitFor(() => exists('#oa-input-ta'), { what: 'alpha activated' });

    await click('#oa-settings-btn');
    await waitFor(() => js(`!!document.querySelector('[data-testid="oa-settings-tab"][data-tab="tools"]')`), { what: 'Outils tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
    await waitFor(() => exists('[data-testid="oa-plugin-entry"]'), { what: 'the real plugin is listed' });
    assert.match(await text('[data-testid="oa-plugin-entry"]'), /greet_plugin/);
    await waitFor(() => exists('[data-testid="oa-plugin-error"]'), { what: 'the broken plugin error is shown' });
    assert.match(await text('[data-testid="oa-plugin-error"]'), /broken\.mjs/);
    await writeFile(join(screenshotDir, 'plugin-1-list.png'), await capturePng(win));

    process.stdout.write(`PASS plugin section: real plugin file listed, real broken-plugin error shown (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_PLUGIN_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL plugin visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
