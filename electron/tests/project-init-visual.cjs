// Run with Electron, not node. Proves "⚡ Init projet" end to end through the real UI and the
// REAL worker.mjs: a real click opens the confirmation dialog, a real click on Confirmer runs the
// real init-project op against a real project folder, and OPENAGENT.md is really written to disk.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-projectinit-'));
  const home = join(root, 'home');
  const project = join(root, 'mon-projet-python');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'app.py'), 'print("hello")\n');
  await writeFile(join(project, 'requirements.txt'), 'flask\n');

  const screenshotDir = process.env.OPENAGENT_PROJECTINIT_SCREENSHOT_DIR || home;
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
      if (request.op === 'open-folder') return project;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: '', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
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

    // ── Clicking "Init projet" before any folder is open shows a warning, writes nothing ─────────
    await click('#oa-init-project-btn');
    await waitFor(async () => /dossier/i.test(await text('[data-testid="oa-toast"]')), { what: 'warning toast with no folder open' });

    await click('#oa-open-folder-btn');
    await waitFor(() => exists('[data-testid="oa-folder-entry"][data-active="true"]'), { what: 'folder activated' });

    // ── A real click opens the confirmation, showing the real active folder path ───────────────────
    await click('#oa-init-project-btn');
    await waitFor(() => exists('#oa-init-project-confirm-btn'), { what: 'confirmation dialog opens' });
    assert.match(await text('[data-testid="oa-modal"]'), /mon-projet-python/);
    await writeFile(join(screenshotDir, 'projectinit-1-confirm.png'), await capturePng(win));

    // ── A real click on Confirmer runs the real scan + write ────────────────────────────────────────
    await click('#oa-init-project-confirm-btn');
    await waitFor(async () => /OPENAGENT\.md généré/.test(await text('[data-testid="oa-toast"]')), { timeout: 10000, what: 'success toast' });
    await writeFile(join(screenshotDir, 'projectinit-2-done.png'), await capturePng(win));

    const content = await readFile(join(project, 'OPENAGENT.md'), 'utf8');
    assert.match(content, /Python/, 'the real scan detected the real .py/.txt files');
    assert.match(content, /requirements\.txt|pip/);

    process.stdout.write(`PASS project init: real click, real worker, real OPENAGENT.md written from a real scan (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'projectinit-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_PROJECTINIT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL project-init visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
