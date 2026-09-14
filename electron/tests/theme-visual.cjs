// Run with Electron, not node. Loads the real preload.cjs + built renderer against a
// minimal backend-request handler backed by a real (temp-dir) SettingsService — proves
// ThemeProvider/theme.css end to end (DOM attribute, --accent CSS variable, and actual
// disk persistence of the choice) without needing the full main.cjs app lifecycle or the
// real user home directory.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

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

    // The only button in the placeholder App is the theme toggle.
    await win.webContents.executeJavaScript("document.querySelector('button').click()");
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

    process.stdout.write(`PASS theme toggle applies to the DOM/CSS and persists to disk (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${join(screenshotDir, 'theme-dark.png')}, ${join(screenshotDir, 'theme-light.png')}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_THEME_SCREENSHOT_DIR) await rm(home, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch(error => {
  process.stderr.write(`FAIL theme visual: ${error.stack || error}\n`);
  app.exit(1);
});
