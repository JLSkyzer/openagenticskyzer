// Run with Electron, not node. Loads the real preload.cjs + built renderer against a
// backend-request handler backed by a real (temp-dir) FoldersService — proves the
// Sidebar end to end: click → moves to the front of the history → survives a "restart"
// (a fresh FoldersService instance over the same temp home reads the same order back).
// Parity row 2 (2026-10-05): a path typed in « Chemin du dossier » opens the folder (quoted, forward slashes, or by
// Enter) through the same activate(); the entry shows its name, cut path and date; an empty, relative, missing or
// non-folder path is refused by a toast and activates nothing.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-sidebar-'));
  const home = join(root, 'home');
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  const c = join(root, 'project-c');
  const aFile = join(root, 'un-fichier.txt');
  await Promise.all([mkdir(home), mkdir(a), mkdir(b), mkdir(c)]);
  await writeFile(aFile, 'pas un dossier');
  const screenshotDir = process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR || home;
  let win;
  try {
    const { FoldersService, canonicalFolderPath } = await import('../core/folders.mts');
    const { SettingsService } = await import('../core/settings.mts');
    const folders = new FoldersService(home);
    const settings = new SettingsService(home);
    // Seed history as if a previous session had opened a then b — b starts at the front.
    await folders.recordOpened(a);
    await folders.recordOpened(b);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'list_folders') return folders.list();
      if (request.op === 'activate_folder') {
        // As worker.mjs answers it: the history, the list, and the folder under the spelling the history stores.
        const list = await folders.recordOpened(request.payload.folder);
        return { history: [], folders: list, folder: await canonicalFolderPath(request.payload.folder) };
      }
      if (request.op === 'open-folder') return null;
      if (request.op === 'global-settings') return settings.publicGlobal();
      if (request.op === 'save-global-settings') return settings.saveGlobal(request.payload.patch);
      // ChatProvider (Tâche 7) also mounts alongside the Sidebar and fetches the active
      // folder's history — not under test here, just needs a quiet reply.
      if (request.op === 'messages') return [];
      throw new Error('opération inattendue dans le test sidebar : ' + request.op);
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 300));

    const js = code => win.webContents.executeJavaScript(code);
    const names = () => js("Array.from(document.querySelectorAll('.oa-folder-name')).map(el => el.textContent)");
    const activeName = () => js(`document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')?.querySelector('.oa-folder-name')?.textContent ?? null`);

    const namesBefore = await names();
    assert.deepEqual(namesBefore, ['project-b', 'project-a'], 'history loads in most-recently-used order on mount (restart)');
    await writeFile(join(screenshotDir, 'sidebar-before-click.png'), await capturePng(win));

    // Click the (currently second, inactive) project-a entry.
    await js("document.querySelector('[data-testid=\"oa-folder-entry\"][data-path$=\"project-a\"]').click()");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await names(), ['project-a', 'project-b'], 'clicking a history entry moves it to the front');
    assert.equal(await activeName(), 'project-a', 'the clicked folder is highlighted as active');

    // main.py's top bar shows only the basename after ▸, not the full path.
    const activePathText = await js("Array.from(document.querySelectorAll('span')).map(el => el.textContent).find(t => t?.startsWith('▸'))");
    assert.ok(activePathText?.includes('project-a'), 'the active folder basename is shown in the top bar');
    await writeFile(join(screenshotDir, 'sidebar-after-click.png'), await capturePng(win));

    // "Restart": a fresh FoldersService over the same temp home must see the same order —
    // this is a real disk read, not React state.
    assert.deepEqual((await new FoldersService(home).list()).map(e => e.name), ['project-a', 'project-b'], 'the new order actually persisted to disk');

    // ── Parity row 2: « Chemin du dossier » + « Ouvrir » ──────────────────────────
    const typePath = value => js(`(() => {
      const el = document.getElementById('oa-folder-path-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // Toasts already on screen are marked, so a refusal is matched only by the toast it raised itself.
    const markToasts = () => js(`document.querySelectorAll('[data-testid="oa-toast"]').forEach(el => { el.dataset.seen = '1'; })`);
    const newToast = pattern => waitFor(async () => {
      const fresh = await js(`[...document.querySelectorAll('[data-testid="oa-toast"]:not([data-seen])')].map(el => ({ text: el.textContent, kind: el.dataset.kind }))`);
      return fresh.find(toast => pattern.test(toast.text)) ?? null;
    }, { what: `a toast matching ${pattern}` });

    assert.equal(await js("document.getElementById('oa-folder-path-input')?.placeholder"), 'Chemin du dossier');
    assert.equal(await js("document.getElementById('oa-folder-path-open')?.textContent"), 'Ouvrir');

    // A valid path, typed the way Explorer copies it (quoted) and with forward slashes → active, first in the history.
    await typePath(`"${c.replaceAll('\\', '/')}"`);
    await js("document.getElementById('oa-folder-path-open').click()");
    await waitFor(async () => (await names())[0] === 'project-c', { what: 'project-c first in the history' });
    assert.deepEqual(await names(), ['project-c', 'project-a', 'project-b']);
    assert.equal(await activeName(), 'project-c', 'the typed folder is the active one');
    assert.equal(await js("document.getElementById('oa-folder-path-input').value"), '', 'the field is emptied once the folder is open');
    const [cEntry] = await new FoldersService(home).list();
    const canonicalC = await realpath(c);
    assert.equal(cEntry.path, canonicalC, 'recorded under its canonical path');
    const shownPath = canonicalC.length > 30 ? `${canonicalC.slice(0, 30)}…` : canonicalC;
    const shownDate = await js(`new Date(${JSON.stringify(cEntry.last_used)}).toLocaleDateString()`);
    const firstEntry = selector => js(`document.querySelector('[data-testid="oa-folder-entry"]').querySelector(${JSON.stringify(selector)}).textContent`);
    assert.equal(await firstEntry('.oa-folder-name'), 'project-c', 'the entry shows the folder name');
    assert.equal(await firstEntry('.oa-folder-path'), `${shownPath} · ${shownDate}`, 'the entry shows the (cut) path and the date');
    await writeFile(join(screenshotDir, 'sidebar-typed-path.png'), await capturePng(win));

    // Enter validates too.
    await typePath(a);
    await js(`document.getElementById('oa-folder-path-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(async () => (await names())[0] === 'project-a', { what: 'project-a first again, by Enter' });
    assert.equal(await activeName(), 'project-a');

    // Refused: empty, relative, missing, a file — a clear toast, nothing activated, nothing recorded.
    const expectedOrder = ['project-a', 'project-c', 'project-b'];
    for (const [value, reason] of [['   ', /chemin vide/], ['relatif\\dossier', /absolu/], [join(root, 'absent'), /introuvable/], [aFile, /introuvable/]]) {
      await markToasts();
      await typePath(value);
      await js("document.getElementById('oa-folder-path-open').click()");
      const toast = await newToast(/^Impossible d’ouvrir ce dossier : /);
      assert.equal(toast.kind, 'negative', value);
      assert.match(toast.text, reason, value);
      assert.equal(toast.text.includes('Error invoking remote method'), false, `${value}: the worker's own reason, not the IPC wrapper`);
      assert.deepEqual(await names(), expectedOrder, `${value}: the history is unchanged`);
      assert.equal(await activeName(), 'project-a', `${value}: nothing else was activated`);
    }
    assert.deepEqual((await new FoldersService(home).list()).map(e => e.name), expectedOrder, 'nothing was recorded on disk');
    await writeFile(join(screenshotDir, 'sidebar-typed-refused.png'), await capturePng(win));

    process.stdout.write(`PASS sidebar click moves folder to front and persists; a typed path opens (quoted, forward slashes, Enter) and invalid ones are refused (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL sidebar visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
