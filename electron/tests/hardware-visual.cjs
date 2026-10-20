// Run with Electron, not node. The « 🖥️ Matériel » settings tab end to end, through the real built renderer and the
// REAL worker.mjs (hardware and offload, Task 7): the lines are the worker's own hardware-info in French, « Relire »
// really re-reads, and « Contexte des modèles locaux » is saved by Enregistrer into config.json. OPENAGENT_HOME is a
// fresh temporary folder: the user's data is never read or written.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-hardware-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    const { hardwareLines } = await import(pathToFileURL(join(__dirname, '..', 'renderer-src', 'src', 'components', 'settings', 'hardware-view.ts')).href);
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
    });
    const callWorker = (op, payload = {}) => {
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ op, payload, id });
      });
    };
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      return callWorker(request.op, request.payload);
    });

    win = new BrowserWindow({
      show: true,
      opacity: 0,
      focusable: false,
      width: 1080,
      height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const lineText = field => js(`document.querySelector('[data-testid="oa-hardware-line"][data-field="${field}"]')?.textContent ?? null`);
    const reads = () => js(`document.querySelector('[data-testid="oa-hardware"]')?.dataset.reads ?? null`);

    // ── 1. Settings → Matériel ──────────────────────────────────────────────────────
    await click('#oa-settings-btn');
    await waitFor(() => exists('[data-testid="oa-settings-tab"][data-tab="hardware"]'), { what: 'the Matériel tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="hardware"]');
    await waitFor(async () => (await js(`document.querySelector('[data-testid="oa-settings-panel"]')?.dataset.tab`)) === 'hardware', { what: 'the Matériel panel is shown' });

    // ── 2. The lines appear once the worker has answered (none before: the tab renders no line until then) ─
    await waitFor(() => exists('[data-testid="oa-hardware-line"][data-field="backend"]'), { timeout: 120000, what: 'the first hardware-info answer' });
    assert.equal(await reads(), '1', 'one read on opening the tab');

    // ── 3. Each line is the worker's own hardware-info in French ───────────────────────
    const expected = hardwareLines(await callWorker('hardware-info', { refresh: false }));
    for (const field of ['backend', 'gpu', 'cpu']) {
      assert.equal(await lineText(field), expected.find(line => line.field === field).text, `the ${field} line matches hardware-info`);
    }
    assert.match(await lineText('ram'), /^RAM : .+ au total, .+ libres$/, 'free memory moves: the RAM line is matched by shape');
    if (expected.some(line => line.field === 'vram')) {
      assert.match(await lineText('vram'), /^VRAM : .+ au total, .+ libres$/, 'free memory moves: the VRAM line is matched by shape');
    } else {
      assert.equal(await lineText('vram'), null, 'no card in use: no VRAM line');
    }

    // ── 4. « Relire » really reads again ────────────────────────────────────────────────
    await click('[data-testid="oa-hardware-refresh-btn"]');
    await waitFor(async () => (await reads()) === '2', { timeout: 60000, what: 'the second read (data-reads="2")' });

    // ── 5. « Contexte des modèles locaux »: 64k, saved by Enregistrer like every tab ──────
    assert.equal(await js(`document.querySelector('[data-setting="local_context"]').value`), '32768', 'the default is 32k');
    await js(`(() => {
      const el = document.querySelector('[data-setting="local_context"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '65536');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await click('#oa-settings-save-btn');
    await waitFor(async () => /Paramètres sauvegardés/.test(await js(`document.querySelector('[data-testid="oa-settings-status"]')?.textContent || ''`)), { what: 'the save is confirmed' });
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.local_context, 65536, 'config.json holds local_context: 65536');

    // ── 6. One capture for a human look ─────────────────────────────────────────────────
    await writeFile(join(screenshotDir, 'settings-hardware.png'), await capturePng(win));

    process.stdout.write(`PASS hardware tab: the worker's own machine lines, a real re-read, local_context saved (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'settings-hardware.png')}\n`);
  } finally {
    win?.destroy();
    await worker?.terminate();
    if (!process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL hardware tab visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
