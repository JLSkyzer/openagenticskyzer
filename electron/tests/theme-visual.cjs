// Run with Electron, not node. Loads the real preload.cjs + built renderer against a
// minimal backend-request handler backed by a real (temp-dir) SettingsService — proves
// ThemeProvider/theme.css end to end (DOM attribute, --accent CSS variable, and actual
// disk persistence of the choice) without needing the full main.cjs app lifecycle or the
// real user home directory.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

// app.exit() can cut stdout/stderr before an async pipe write (common on Windows)
// actually reaches the OS — flush both explicitly before exiting instead of racing them.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

app.whenReady().then(async () => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-theme-'));
  const screenshotDir = process.env.OPENAGENT_THEME_SCREENSHOT_DIR || home;
  let win;
  try {
    const { SettingsService } = await import('../core/settings.mts');
    const settings = new SettingsService(home);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'global-settings') return settings.publicGlobal();
      if (request.op === 'save-global-settings') return settings.saveGlobal(request.payload.patch);
      // The Sidebar (Tâche 6) also mounts alongside the theme toggle placeholder and
      // fetches its own history on load — not under test here, just needs a quiet reply.
      if (request.op === 'list_folders') return [];
      if (request.op === 'open-folder') return null;
      throw new Error('opération inattendue dans le test de thème : ' + request.op);
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
    // Let the ThemeProvider effect resolve the (default) loaded settings.
    await new Promise(resolve => setTimeout(resolve, 200));

    const initialTheme = await win.webContents.executeJavaScript("document.documentElement.getAttribute('data-theme')");
    assert.equal(initialTheme, 'dark', 'defaults to the dark theme');
    const initialAccent = await win.webContents.executeJavaScript(
      "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()",
    );
    assert.equal(initialAccent, '#3b82f6', 'defaults to the Python accent color (theme.py::_DEFAULT_ACCENT)');

    const darkShot = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'theme-dark.png'), darkShot.toPNG());

    // Theme + accent live in Réglages > Apparence now (like settings.py) — reach the
    // control the way a user would: ⚙️, then the Apparence tab, then "Clair".
    await win.webContents.executeJavaScript("document.getElementById('oa-settings-btn').click()");
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript("document.querySelector('[data-testid=\"oa-settings-tab\"][data-tab=\"appearance\"]').click()");
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript("document.getElementById('oa-theme-light-btn').click()");
    await new Promise(resolve => setTimeout(resolve, 100));
    const toggledTheme = await win.webContents.executeJavaScript("document.documentElement.getAttribute('data-theme')");
    assert.equal(toggledTheme, 'light', 'toggles to the light theme on click');

    const lightShot = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'theme-light.png'), lightShot.toPNG());

    // Persistence: a fresh SettingsService over the same temp home must see the choice
    // the click made through the real IPC round trip, not just in-memory React state.
    const reopened = new SettingsService(home);
    const persisted = await reopened.publicGlobal();
    assert.equal(persisted.theme, 'light', 'the toggle click actually persisted to disk, not just React state');

    // ── Parity row 16: the accent chosen in Réglages > Apparence — applied to --accent, saved, kept after a reload ──
    const accentNow = () => win.webContents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    await win.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('oa-accent-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '#ff0000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => (await accentNow()) === '#ff0000', { what: '--accent applied' });
    await waitFor(async () => (await new SettingsService(home).global()).accent_color === '#ff0000', { what: 'accent saved' });
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).accent_color, '#ff0000', 'written to config.json');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await waitFor(async () => (await accentNow()) === '#ff0000', { what: 'the accent after a reload' });
    assert.equal(await win.webContents.executeJavaScript("document.documentElement.getAttribute('data-theme')"), 'light', 'the theme survives the reload too');
    const accentShot = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'theme-accent.png'), accentShot.toPNG());

    process.stdout.write(`PASS theme toggle applies to the DOM/CSS and persists to disk; accent #ff0000 applied, saved and kept after a reload (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${join(screenshotDir, 'theme-dark.png')}, ${join(screenshotDir, 'theme-light.png')}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_THEME_SCREENSHOT_DIR) await rm(home, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL theme visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
