// Run with Electron, not node. Proves the first-launch wizard end to end through the real UI and the REAL
// worker.mjs, WITHOUT the test-only skip: it covers the interface on a fresh data directory, cannot be dismissed
// (a real Escape key, a real click on the backdrop), walks its four steps with real mouse clicks, opens the REAL
// model selector above itself and the REAL folder opening, shows only shortcuts that exist, saves
// `onboarding_done` to config.json only at the very end (a reload before that brings it back), keeps itself open
// with a message when the save is refused, and never comes back once done. Nothing here opens an external application.
const { app, BrowserWindow, ipcMain } = require('electron');
const { capturePng } = require('./capture-helper.cjs');
// The helpers above set the skip for every other test; this one proves the wizard itself, so it must not have it.
delete process.env.OPENAGENT_SKIP_ONBOARDING;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-onboarding-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  const screenshotDir = process.env.OPENAGENT_ONBOARDING_SCREENSHOT_DIR || home;
  const pageMessages = [];
  let win;
  let worker;
  try {
    assert.equal(process.env.OPENAGENT_SKIP_ONBOARDING, undefined, 'this test runs without the skip');
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    let failSave = false;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return alpha;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'm', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      if (request.op === 'save-global-settings' && failSave) return Promise.reject(new Error('Disque plein (simulé)'));
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
    const load = async () => { await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html')); await pause(500); };
    await load();

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const step = () => js(`document.querySelector('[data-testid="oa-onboarding"]')?.dataset.step || null`);
    const configOnDisk = async () => { try { return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); } catch { return {}; } };
    const rectCenter = selector => js(`(() => {
      const r = document.querySelector(${q(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const realClick = async selector => {
      const { x, y } = await rectCenter(selector);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    const key = keyCode => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    // Whether the element REALLY on top at a point of the window (not merely present in the DOM) is inside a container.
    const topmostIn = (x, y, containerSelector) => js(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      return !!el && !!el.closest(${q(containerSelector)});
    })()`);
    const goTo = async target => {
      const order = ['welcome', 'model', 'folder', 'done'];
      const buttons = { welcome: '#oa-onboarding-start', model: '#oa-onboarding-next', folder: '#oa-onboarding-next' };
      while ((await step()) !== target) {
        const current = await step();
        await realClick(buttons[current]);
        await waitFor(async () => (await step()) === order[order.indexOf(current) + 1], { what: `leave step ${current}` });
      }
    };

    // ── 1. A fresh data directory: the wizard shows, on top of everything ─────────────────────────────────────
    await waitFor(() => exists('[data-testid="oa-onboarding"]'), { what: 'the wizard shows on a fresh directory' });
    assert.equal(await step(), 'welcome');
    assert.match(await text('[data-testid="oa-onboarding"]'), /Bienvenue dans OpenAgentic Skyzer/);
    const send = await rectCenter('#oa-send-btn');
    assert.equal(await topmostIn(send.x, send.y, '[data-testid="oa-modal-backdrop"]'), true, 'the wizard covers the send button: it really is on top');
    await writeFile(join(screenshotDir, 'onboarding-1-welcome.png'), await capturePng(win));

    // ── 2. It cannot be dismissed: a real Escape, a real click on the backdrop ─────────────────────────────────
    key('Escape');
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 8, y: 8, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 8, y: 8, button: 'left', clickCount: 1 });
    await pause(400);
    assert.equal(await exists('[data-testid="oa-onboarding"]'), true, 'still there after Escape and a click outside');
    assert.equal(await step(), 'welcome');

    // ── 3. Real clicks through the steps; the model selector opens ABOVE the wizard ────────────────────────────
    await realClick('#oa-onboarding-start');
    await waitFor(async () => (await step()) === 'model', { what: 'step 2' });
    assert.match(await text('[data-testid="oa-onboarding"]'), /Choisissez votre modèle/);
    await realClick('#oa-onboarding-model-open');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { what: 'the model selector opens' });
    const modelDialog = await rectCenter('[data-testid="oa-model-active"]');
    assert.equal(
      await js(`(() => { const el = document.elementFromPoint(${modelDialog.x}, ${modelDialog.y}); return !!el && !el.closest('[data-testid="oa-onboarding"]'); })()`),
      true, 'what is on top at the selector\'s centre is NOT part of the wizard: the selector is above it, not under it',
    );
    await writeFile(join(screenshotDir, 'onboarding-2-model-above.png'), await capturePng(win));
    // Escape closes the selector only (the topmost modal), never the wizard beneath it.
    key('Escape');
    await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')), { what: 'Escape closed the selector' });
    assert.equal(await step(), 'model', 'the wizard is still on its step');

    // ── 4. Back and forth, then the folder step: "Passer" until a folder is open ───────────────────────────────
    await realClick('#oa-onboarding-back');
    await waitFor(async () => (await step()) === 'welcome', { what: 'back to step 1' });
    await goTo('folder');
    assert.equal((await text('#oa-onboarding-next')).trim(), 'Passer');
    await realClick('#oa-onboarding-folder-open');
    await waitFor(async () => (await text('#oa-onboarding-next')).trim() === 'Suivant →', { what: 'the folder opened for real, and the button follows' });
    assert.match(await text('body'), /alpha/, 'the folder shows in the app');
    await writeFile(join(screenshotDir, 'onboarding-3-folder.png'), await capturePng(win));

    // ── 5. Reloading before the end brings the wizard back: nothing was saved early ─────────────────────────────
    assert.notEqual((await configOnDisk()).onboarding_done, true, 'nothing saved before the end');
    await load();
    await waitFor(() => exists('[data-testid="oa-onboarding"]'), { what: 'the wizard is back after a reload' });
    assert.equal(await step(), 'welcome');

    // ── 6. The last screen shows only shortcuts that exist ───────────────────────────────────────────────────────
    await goTo('done');
    const shortcuts = await js(`[...document.querySelectorAll('[data-testid="oa-onboarding-shortcuts"] > div')].map(e => e.textContent)`);
    assert.deepEqual(shortcuts, ['Ctrl+K — Palette de commandes', 'Entrée — Envoyer le message', 'Shift+Entrée — Nouvelle ligne']);
    await writeFile(join(screenshotDir, 'onboarding-4-done.png'), await capturePng(win));

    // ── 7. A refused save keeps the wizard open with a message, and saves nothing ──────────────────────────────
    failSave = true;
    await realClick('#oa-onboarding-finish');
    await waitFor(() => exists('[data-testid="oa-onboarding-error"]'), { what: 'the refusal is shown' });
    assert.match(await text('[data-testid="oa-onboarding-error"]'), /Disque plein/);
    assert.equal(await exists('[data-testid="oa-onboarding"]'), true, 'still open');
    assert.notEqual((await configOnDisk()).onboarding_done, true);

    // ── 8. Finishing for real: written to disk, wizard gone, and it never comes back ───────────────────────────
    failSave = false;
    await realClick('#oa-onboarding-finish');
    await waitFor(async () => !(await exists('[data-testid="oa-onboarding"]')), { what: 'wizard closed' });
    assert.equal((await configOnDisk()).onboarding_done, true, 'config.json now says onboarding_done');
    const send2 = await rectCenter('#oa-send-btn');
    assert.equal(await topmostIn(send2.x, send2.y, '[data-testid="oa-modal-backdrop"]'), false, 'the interface is usable again');
    await load();
    await pause(600);
    assert.equal(await exists('[data-testid="oa-onboarding"]'), false, 'does not come back after a reload');

    process.stdout.write(`PASS onboarding wizard: covers a fresh install, cannot be dismissed, four steps by real clicks, real selector above it, real folder opening, only real shortcuts, saved only at the end, refused save kept open, never returns (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'onboarding-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-8))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_ONBOARDING_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL onboarding visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
