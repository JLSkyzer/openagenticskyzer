// Run with Electron, not node. Proves the Settings dialog shell end to end in the real
// built renderer at the app's real minimum window size: opened by the real ⚙️ button,
// 7 vertical tabs in the NiceGUI order with the right labels, 200px left rail, panel
// switching by real clicks, Fermer / Escape closing it, and no overflow.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
// Destroying the window in `finally` would otherwise quit the app (Electron's default)
// before a failing run gets to print its error — keep the process alive until we exit.
app.on('window-all-closed', () => {});
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-settings-'));
  const home = join(root, 'home');
  const project = join(root, 'mon-projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR || home;
  let win;
  try {
    const { FoldersService } = await import('../core/folders.mts');
    const { SettingsService } = await import('../core/settings.mts');
    const folders = new FoldersService(home);
    const settings = new SettingsService(home);
    await folders.recordOpened(project);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'list_folders') return folders.list();
      if (request.op === 'activate_folder') {
        return { history: [], folders: await folders.recordOpened(request.payload.folder) };
      }
      if (request.op === 'open-folder') return project;
      if (request.op === 'global-settings') return settings.publicGlobal();
      if (request.op === 'save-global-settings') return settings.saveGlobal(request.payload.patch);
      throw new Error('opération inattendue dans le test réglages : ' + request.op);
    });

    // Shown but fully transparent: a hidden (show:false) window stops painting after
    // load, so capturePage() kept returning the frame from before the dialog opened.
    win = new BrowserWindow({
      show: true,
      opacity: 0,
      focusable: false,
      width: 1080,
      height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(300);
    const js = code => win.webContents.executeJavaScript(code);
    const dialogOpen = () => js("!!document.querySelector('[data-testid=\"oa-settings-dialog\"]')");

    assert.equal(await dialogOpen(), false, 'the dialog is closed at startup');
    assert.equal(await js("(() => { const b = document.getElementById('oa-settings-btn'); return !!b && !b.disabled; })()"), true, 'the ⚙️ button exists and is a real, enabled button');

    await js("document.getElementById('oa-settings-btn').click()");
    await pause(150);
    assert.equal(await dialogOpen(), true, 'clicking ⚙️ opens the settings dialog');

    const tabs = await js(`Array.from(document.querySelectorAll('[data-testid="oa-settings-tab"]')).map(t => ({ id: t.dataset.tab, text: t.textContent.trim() }))`);
    assert.deepEqual(
      tabs.map(t => t.id),
      ['general', 'appearance', 'context', 'permissions', 'tools', 'folder', 'danger'],
      'the 7 tabs, in the NiceGUI order',
    );
    assert.deepEqual(
      tabs.map(t => t.text),
      ['🌐 Général', '🎨 Apparence', '🧠 Contexte & Mémoire', '🔒 Permissions', '🧩 Outils', '📁 Dossier', '⚠️ Danger'],
      'the labels match settings.py, "Dossier" while no folder is active',
    );

    const rail = await js(`(() => { const el = document.querySelector('[data-testid="oa-settings-rail"]'); return { width: el.getBoundingClientRect().width, text: el.textContent }; })()`);
    assert.equal(Math.round(rail.width), 200, 'the left rail is 200px wide like settings.py');
    assert.match(rail.text, /Paramètres/, 'the rail carries the "Paramètres" header');

    assert.equal(await js("document.querySelector('[data-testid=\"oa-settings-tab\"][data-active=\"true\"]')?.dataset.tab"), 'general', 'Général is the default tab');
    assert.equal(await js("document.querySelector('[data-testid=\"oa-settings-panel\"]')?.dataset.tab"), 'general');

    await js("document.querySelector('[data-testid=\"oa-settings-tab\"][data-tab=\"appearance\"]').click()");
    await pause(100);
    assert.equal(await js("document.querySelector('[data-testid=\"oa-settings-panel\"]')?.dataset.tab"), 'appearance', 'a real tab click switches the panel');
    assert.equal(await js("document.querySelector('[data-testid=\"oa-settings-tab\"][data-active=\"true\"]')?.dataset.tab"), 'appearance');
    assert.equal(await js("!!document.getElementById('oa-theme-light-btn') && !!document.getElementById('oa-theme-dark-btn')"), true, 'theme + accent controls live in the Apparence tab now');

    const geometry = await js(`(() => {
      const dialog = document.querySelector('[data-testid="oa-settings-dialog"]').getBoundingClientRect();
      const save = document.getElementById('oa-settings-save-btn');
      const close = document.getElementById('oa-settings-close-btn');
      return {
        dialog: { x: dialog.x, y: dialog.y, w: dialog.width, h: dialog.height },
        inner: [window.innerWidth, window.innerHeight],
        scrollWidth: document.documentElement.scrollWidth,
        hasSave: !!save, hasClose: !!close, saveText: save?.textContent.trim(), closeText: close?.textContent.trim(),
      };
    })()`);
    assert.ok(geometry.hasSave && geometry.hasClose, 'the footer has Enregistrer and Fermer');
    assert.equal(geometry.saveText, 'Enregistrer');
    assert.equal(geometry.closeText, 'Fermer');
    assert.ok(Math.abs(geometry.dialog.w - geometry.inner[0]) <= 1 && Math.abs(geometry.dialog.h - geometry.inner[1]) <= 1, 'the dialog is maximized over the whole window');
    assert.ok(geometry.scrollWidth <= geometry.inner[0], 'no horizontal overflow with the dialog open');
    const covered = await js(`(() => {
      const dialog = document.querySelector('[data-testid="oa-settings-dialog"]');
      const points = [[20, 20], [600, 300], [window.innerWidth - 20, window.innerHeight - 20], [20, window.innerHeight - 20]];
      return points.map(([x, y]) => dialog.contains(document.elementFromPoint(x, y)));
    })()`);
    assert.deepEqual(covered, [true, true, true, true], 'the dialog really sits on top of the TopBar, sidebar and chat at every corner and the center');

    // capturePage() on a hidden window can return a stale frame — force two fresh paints
    // and let them settle before trusting the snapshot (same recipe as layout-visual).
    await writeFile(join(screenshotDir, 'settings-appearance.png'), await capturePng(win));

    await js("document.getElementById('oa-settings-close-btn').click()");
    await pause(100);
    assert.equal(await dialogOpen(), false, 'Fermer closes the dialog');

    await js("document.getElementById('oa-settings-btn').click()");
    await pause(100);
    assert.equal(await dialogOpen(), true);
    assert.equal(
      await js("document.querySelector('[data-testid=\"oa-settings-tab\"][data-active=\"true\"]')?.dataset.tab"),
      'general',
      'reopening starts on Général again',
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await pause(100);
    assert.equal(await dialogOpen(), false, 'Escape closes the dialog');

    // With a real folder active the per-project tab is named after it, like settings.py.
    await js("document.getElementById('oa-open-folder-btn').click()");
    await pause(300);
    await js("document.getElementById('oa-settings-btn').click()");
    await pause(100);
    assert.equal(
      await js("document.querySelector('[data-testid=\"oa-settings-tab\"][data-tab=\"folder\"]').textContent.trim()"),
      '📁 mon-projet',
      'the folder tab shows the active folder name',
    );

    process.stdout.write(`PASS settings dialog shell: 7 tabs, real clicks, Fermer/Escape, maximized without overflow (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'settings-appearance.png')}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL settings visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
