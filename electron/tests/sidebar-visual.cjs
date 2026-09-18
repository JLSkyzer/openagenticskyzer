// Run with Electron, not node. Loads the real preload.cjs + built renderer against a
// backend-request handler backed by a real (temp-dir) FoldersService — proves the
// Sidebar end to end: click → moves to the front of the history → survives a "restart"
// (a fresh FoldersService instance over the same temp home reads the same order back).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return new Promise(resolve => process.stdout.write('', resolve));
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-sidebar-'));
  const home = join(root, 'home');
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  await Promise.all([mkdir(home), mkdir(a), mkdir(b)]);
  const screenshotDir = process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR || home;
  let win;
  try {
    const { FoldersService } = await import('../core/folders.mts');
    const { SettingsService } = await import('../core/settings.mts');
    const folders = new FoldersService(home);
    const settings = new SettingsService(home);
    // Seed history as if a previous session had opened a then b — b starts at the front.
    await folders.recordOpened(a);
    await folders.recordOpened(b);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'list_folders') return folders.list();
      if (request.op === 'activate_folder') {
        const list = await folders.recordOpened(request.payload.folder);
        return { history: [], folders: list };
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

    const namesBefore = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.oa-folder-name')).map(el => el.textContent)",
    );
    assert.deepEqual(namesBefore, ['project-b', 'project-a'], 'history loads in most-recently-used order on mount (restart)');

    const shotBefore = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'sidebar-before-click.png'), shotBefore.toPNG());

    // Click the (currently second, inactive) project-a entry.
    await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-folder-entry\"][data-path$=\"project-a\"]').click()",
    );
    await new Promise(resolve => setTimeout(resolve, 200));

    const namesAfter = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.oa-folder-name')).map(el => el.textContent)",
    );
    assert.deepEqual(namesAfter, ['project-a', 'project-b'], 'clicking a history entry moves it to the front');

    const activeAfter = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-folder-entry\"][data-active=\"true\"]')?.querySelector('.oa-folder-name')?.textContent",
    );
    assert.equal(activeAfter, 'project-a', 'the clicked folder is highlighted as active');

    // main.py's top bar shows only the basename after ▸, not the full path.
    const activePathText = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('span')).map(el => el.textContent).find(t => t?.startsWith('▸'))",
    );
    assert.ok(activePathText?.includes('project-a'), 'the active folder basename is shown in the top bar');

    const shotAfter = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'sidebar-after-click.png'), shotAfter.toPNG());

    // "Restart": a fresh FoldersService over the same temp home must see the same order —
    // this is a real disk read, not React state.
    const reopened = new FoldersService(home);
    const persisted = await reopened.list();
    assert.deepEqual(persisted.map(e => e.name), ['project-a', 'project-b'], 'the new order actually persisted to disk');

    process.stdout.write(`PASS sidebar click moves folder to front and persists (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${join(screenshotDir, 'sidebar-before-click.png')}, ${join(screenshotDir, 'sidebar-after-click.png')}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL sidebar visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
