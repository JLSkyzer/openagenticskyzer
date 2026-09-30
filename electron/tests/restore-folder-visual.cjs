// Run with Electron, not node. Proves restore_last_folder end to end through the REAL UI and the
// REAL worker.mjs (main.py:254-267 parity): on a cold start, with a real folder history and a real
// persisted conversation, the last-used folder is selected and its real chat shown with NO click at
// all; restore_last_folder=false changes nothing (today's behavior, untouched); a folder deleted
// from disk since last use never crashes the app and leaves nothing active; and a real race — a
// manual click landing before the automatic restore's own activate() call — is never overwritten.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, rm: rmPath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 15000, interval = 50, what = 'condition' } = {}) {
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

async function bootSession(home) {
  const worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
  const pending = new Map();
  let win = null;
  worker.on('message', message => {
    const done = pending.get(message.id);
    if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
    win?.webContents.send('backend-message', message);
  });
  const callWorker = (op, payload) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random()}`;
    pending.set(id, { resolve, reject });
    worker.postMessage({ op, payload, id });
  });
  ipcMain.removeHandler('backend-request');
  ipcMain.handle('backend-request', (_event, request) => {
    if (request.op === 'connection-snapshot') {
      return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
    }
    return callWorker(request.op, request.payload);
  });
  win = new BrowserWindow({
    show: true, opacity: 0, focusable: false, width: 1080, height: 680,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  return { worker, win, callWorker };
}
async function teardown(session) {
  session.win?.destroy();
  await session.worker?.terminate();
}
function js(win, code) {
  return win.webContents.executeJavaScript(code).catch(error => { throw new Error(`page script failed: ${code.slice(0, 160)} — ${error.message.split('\n')[0]}`); });
}
// Windows paths carry backslashes: a CSS attribute selector built from one (`[data-path="D:\..."]`)
// is malformed (CSS escaping isn't JS string escaping) — match by the folder's displayed NAME
// instead, same convention context-visual.cjs's own enter(name) already uses for this exact reason.
const click = (win, name) => js(win, `[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)}))?.click()`);
const isActive = (win, name) => js(win, `[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)}))?.getAttribute('data-active') === 'true'`);
const activeName = (win) => js(win, `document.querySelector('[data-testid="oa-folder-entry"][data-active="true"] .oa-folder-name')?.textContent`);

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-restore-folder-'));
  const screenshotDir = process.env.OPENAGENT_RESTORE_SCREENSHOT_DIR || root;
  try {
    // ── A. restore_last_folder=true (default): last-used folder restored, real history shown, no click ──
    {
      const home = join(root, 'home-a');
      const alpha = join(root, 'alpha-a');
      const beta = join(root, 'beta-a');
      await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
      await writeFile(join(home, 'folders.json'), JSON.stringify([
        { path: alpha, last_used: new Date().toISOString() },
        { path: beta, last_used: new Date(Date.now() - 1000).toISOString() },
      ]));
      const session = await bootSession(home);
      try {
        await session.callWorker('save-messages', { folder: alpha, branchId: 'main', messages: [{ role: 'user', content: 'déjà là avant le démarrage' }, { role: 'assistant', content: 'réponse déjà persistée' }] });
        await session.win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
        await waitFor(() => js(session.win, `!!document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')`), { what: 'a folder is active with no click' });
        assert.equal(await activeName(session.win), 'alpha-a', 'the LAST-USED folder (alpha) was restored, not beta');
        await waitFor(() => js(session.win, `[...document.querySelectorAll('[data-testid="oa-user-bubble"]')].some(e => e.textContent.includes('déjà là avant le démarrage'))`), { what: 'the real persisted history is shown' });
        await writeFile(join(screenshotDir, 'restore-a-restored.png'), await capturePng(session.win));
      } finally { await teardown(session); }
    }

    // ── B. restore_last_folder=false: nothing active, same as before this feature existed ──────────
    {
      const home = join(root, 'home-b');
      const alpha = join(root, 'alpha-b');
      await Promise.all([mkdir(home), mkdir(alpha)]);
      await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
      await writeFile(join(home, 'config.json'), JSON.stringify({ restore_last_folder: false }));
      const session = await bootSession(home);
      try {
        await session.win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
        await waitFor(() => js(session.win, `document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
        await pause(500); // the restore attempt, if it wrongly fired, would have finished well within this
        assert.equal(await js(session.win, `!!document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')`), false, 'restore_last_folder=false: nothing auto-activated');
        assert.match(await js(session.win, `document.body.textContent`), /Ouvre un dossier pour commencer/);
      } finally { await teardown(session); }
    }

    // ── C. the last-used folder was deleted from disk since — no crash, nothing active ─────────────
    {
      const home = join(root, 'home-c');
      const gone = join(root, 'gone-c');
      await Promise.all([mkdir(home), mkdir(gone)]);
      await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: gone, last_used: new Date().toISOString() }]));
      await rmPath(gone, { recursive: true, force: true }); // really gone before the app ever starts
      const session = await bootSession(home);
      try {
        await session.win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
        await waitFor(() => js(session.win, `document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded despite the missing folder' });
        await pause(500);
        assert.equal(await js(session.win, `!!document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')`), false, 'a deleted folder is never force-activated');
        assert.match(await js(session.win, `document.body.textContent`), /Ouvre un dossier pour commencer/, 'the app is still usable, not crashed');
        await writeFile(join(screenshotDir, 'restore-c-deleted.png'), await capturePng(session.win));
      } finally { await teardown(session); }
    }

    // ── D. a real race: a manual click lands before the automatic restore's own activate() call ────
    {
      const home = join(root, 'home-d');
      const alpha = join(root, 'alpha-d');
      const beta = join(root, 'beta-d');
      await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
      await writeFile(join(home, 'folders.json'), JSON.stringify([
        { path: alpha, last_used: new Date().toISOString() }, // would be auto-restored if nothing beat it
        { path: beta, last_used: new Date(Date.now() - 1000).toISOString() },
      ]));
      const session = await bootSession(home);
      try {
        await session.win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
        // As fast as the test can drive it — before the restore effect's own getGlobalSettings +
        // listFolders + activate() round trips (real IPC to the worker) can land.
        await waitFor(() => js(session.win, `document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`), { what: 'both entries present' });
        await click(session.win, 'beta-d');
        await waitFor(() => isActive(session.win, 'beta-d'), { what: 'beta activated by the manual click' });
        await pause(800); // give the automatic restore every chance to fire anyway, if it were going to
        assert.equal(await activeName(session.win), 'beta-d', 'the manual click wins: automatic restore never overrides an already-active folder');
      } finally { await teardown(session); }
    }

    process.stdout.write(`PASS restore last folder: real restore on cold start, disabled by setting, safe on a deleted folder, never overrides a manual click (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    if (!process.env.OPENAGENT_RESTORE_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL restore folder visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
