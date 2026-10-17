// Run with Electron, not node. Proves the model selector end to end through the real built renderer and the REAL
// worker.mjs: the selector is the .gguf library only (no provider, URL or key field), its banner says what the worker
// itself reports (model-status) — none, active, or « introuvable » once the active file is gone — the input bar
// button follows, a send with a missing model is refused with the worker's own message, and choosing another .gguf
// makes it the active one. 'pick-gguf' and 'open-folder' are stubbed (native dialogs nothing can drive); everything
// after them is real. No engine is loaded here: local-model-visual.cjs runs a real turn on the real engine.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, copyFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// Same text as core/active-model.mts::LOCAL_MODEL_MISSING (a .mts module cannot be required from this CommonJS file).
const LOCAL_MODEL_MISSING = 'Modèle local introuvable : il a peut-être été retiré de la bibliothèque. Choisis-en un autre.';
const LONG_NAME = 'stories260K-un-nom-vraiment-long.gguf';

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-model-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  const first = join(root, LONG_NAME);
  const second = join(root, 'stories260K.gguf');
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), first);
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), second);
  const screenshotDir = process.env.OPENAGENT_MODEL_SCREENSHOT_DIR || home;
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
    // Same routing as main.cjs::handleBackendRequest, minus the window-sender check: every op but the native dialogs
    // goes to the real worker, as the page sent it.
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'pick-gguf') return ggufDialogPath;
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
    await pause(400);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const bannerState = () => js(`document.querySelector('[data-testid="oa-model-active"]')?.dataset.state || ''`);
    const openDialog = async () => { await click('#oa-model-btn'); await waitFor(async () => (await bannerState()) !== '', { what: 'the selector shows its banner' }); };
    const closeDialog = async () => { await click('#oa-model-close-btn'); await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')), { what: 'selector closed' }); };
    const writeScreenshot = async name => writeFile(join(screenshotDir, name), await capturePng(win));
    const sendMessage = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);

    await click('#oa-open-folder-btn');
    await waitFor(() => exists('#oa-input-ta'), { what: 'folder opened' });

    // ── 1. Nothing selected: the button and the banner say so, and there is no provider form at all ───────────────
    await waitFor(async () => (await text('#oa-model-btn')) === '● Aucun modèle ▾', { what: 'the button says no model is set' });
    await openDialog();
    assert.equal(await bannerState(), 'none');
    assert.equal(await text('[data-testid="oa-model-active"]'), '⚠ Aucun modèle sélectionné — importe un fichier .gguf.');
    assert.equal(await countOf('[data-model-field]'), 0, 'no provider, model, URL or key field');
    assert.equal(await exists('#oa-model-save-btn'), false, 'nothing to save: picking a .gguf is the whole choice');
    const dialogText = await js('document.body.textContent');
    for (const word of ['Fournisseur', 'Clé API', 'URL de base', 'OpenRouter']) assert.equal(dialogText.includes(word), false, `no « ${word} » on the page`);
    assert.match(await text('[data-testid="oa-local-models"]'), /Aucun modèle importé/);

    // ── 2. Importing a .gguf makes it the active model: banner, button (20 characters) and tooltip ─────────────────
    ggufDialogPath = first;
    await click('#oa-local-model-import-btn');
    await waitFor(async () => (await bannerState()) === 'active', { what: 'the imported model is active' });
    assert.equal(await text('[data-testid="oa-model-active"]'), `✓Modèle actif${LONG_NAME}local`);
    assert.equal(await js(`document.querySelector('[data-testid="oa-local-model-entry"]').dataset.active`), 'true');
    await writeScreenshot('model-1-active.png');
    await closeDialog();
    await waitFor(async () => (await text('#oa-model-btn')) === `● ${LONG_NAME.slice(0, 20)}… ▾`, { what: 'the button truncates the name to 20 characters like input_bar.py' });
    assert.equal(await js(`document.getElementById('oa-model-btn').title`), LONG_NAME, 'the tooltip carries the full name');

    // ── 3. « introuvable »: the active file is deleted from the disk ────────────────────────────────────────────────
    await rm(first);
    // A fresh page reads model-status again, as at the next start.
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await waitFor(() => exists('#oa-open-folder-btn'), { what: 'page reloaded' });
    await click('#oa-open-folder-btn');
    await waitFor(() => exists('#oa-input-ta'), { what: 'folder reopened' });
    await waitFor(async () => (await text('#oa-model-btn')) === '● Aucun modèle ▾', { what: 'a missing model is shown as no model' });
    await sendMessage('Bonjour');
    await waitFor(() => exists('[data-testid="oa-chat-error"]'), { what: 'the send is refused' });
    assert.equal(await text('[data-testid="oa-chat-error"]'), LOCAL_MODEL_MISSING, "the worker's own reason, without the IPC wrapper");
    assert.equal(await countOf('[data-testid="oa-user-bubble"]'), 0, 'nothing was sent');
    await openDialog();
    assert.equal(await bannerState(), 'missing');
    assert.equal(await text('[data-testid="oa-model-active"]'), '⚠ Modèle local introuvable : choisis-en un autre.');
    await writeScreenshot('model-2-missing.png');

    // ── 4. Choosing another .gguf makes it active ──────────────────────────────────────────────────────────────────
    ggufDialogPath = second;
    await click('#oa-local-model-import-btn');
    await waitFor(async () => (await bannerState()) === 'active', { what: 'the other model is active' });
    assert.equal(await text('[data-testid="oa-model-active"]'), '✓Modèle actifstories260K.gguflocal');
    await closeDialog();
    await waitFor(async () => (await text('#oa-model-btn')) === '● stories260K.gguf ▾', { what: 'the button follows' });

    process.stdout.write(`PASS model selector: .gguf library only, banner none/active/introuvable from model-status, button follows, missing model refused (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_MODEL_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL model selector visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
