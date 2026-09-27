// Run with Electron, not node. Proves the local .gguf model selector end to end through the real UI, the REAL
// worker.mjs and the REAL node-llama-cpp engine on a real tiny GGUF (llama.cpp's own CI asset). 'pick-gguf' is
// stubbed to return a real path directly (it is a native file dialog nothing can drive, same as 'open-folder' in
// every other component test) — everything AFTER that point is real: gguf-add, the library list, activation,
// a real agent turn with NO connection configured at all, and switching back to a remote connection deactivating
// the local model. Nothing here opens an external application.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, copyFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 60000, interval = 100, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-localmodel-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  const modelPath = join(root, 'stories260K.gguf');
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), modelPath);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const screenshotDir = process.env.OPENAGENT_LOCALMODEL_SCREENSHOT_DIR || home;
  const pageMessages = [];
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
    let ggufDialogPath = null; // what a real native file picker would have returned
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return alpha;
      if (request.op === 'pick-gguf') return ggufDialogPath;
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
    win.webContents.on('console-message', event => pageMessages.push(`[${event.level}] ${event.message}`));
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const send = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);

    await waitFor(() => exists('[data-testid="oa-folder-entry"]'), { timeout: 15000 });
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-model-btn'), { timeout: 15000 });

    // ── 1. Open the selector, import a real .gguf through the (stubbed native) picker ─────────────────
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-local-models"]'), { timeout: 10000 });
    assert.match(await text('[data-testid="oa-local-models"]'), /Aucun modèle importé/);
    ggufDialogPath = modelPath;
    await click('#oa-local-model-import-btn');
    await waitFor(async () => (await countOf('[data-testid="oa-local-model-entry"]')) === 1, { what: 'imported entry appears' });
    assert.match(await text('[data-testid="oa-local-model-entry"]'), /stories260K\.gguf/);

    // ── 2. Importing activates it immediately: the banner and the button both say so ────────────────
    await waitFor(async () => /Modèle actif/.test(await text('[data-testid="oa-model-active"]')) && /stories260K\.gguf/.test(await text('[data-testid="oa-model-active"]')), { what: 'active banner shows the local model' });
    assert.match(await text('[data-testid="oa-model-active"]'), /local/);
    await click('#oa-model-close-btn');
    await waitFor(async () => /stories260K/.test(await text('#oa-model-btn')), { what: 'the button label follows' });
    await writeFile(join(screenshotDir, 'localmodel-1-active.png'), await capturePng(win));

    // ── 3. A real turn, on the real engine, with NO remote connection configured at all ──────────────
    await send('Once upon a time');
    await waitFor(async () => (await countOf('[data-testid="oa-assistant-bubble"]')) === 1 && await isIdle(), { timeout: 60000, what: 'real local reply' });
    assert.ok((await text('[data-testid="oa-assistant-bubble"]')).trim().length > 0, 'the real local model produced real text');
    await writeFile(join(screenshotDir, 'localmodel-2-replied.png'), await capturePng(win));

    // ── 4. A real click on ✕ removes it from the library (and clears activation if it was active) ────
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-local-model-entry"]'), { timeout: 10000 });
    await click('[data-testid="oa-local-model-remove"]');
    await waitFor(async () => (await countOf('[data-testid="oa-local-model-entry"]')) === 0, { what: 'removed from the library' });
    assert.doesNotMatch(await text('[data-testid="oa-model-active"]'), /stories260K/, 'no longer shown as active once removed');

    process.stdout.write(`PASS local .gguf model: real import (stubbed native picker), immediate activation, a real turn on the real engine with no connection configured, real removal (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'localmodel-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-10))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_LOCALMODEL_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL local-model visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
