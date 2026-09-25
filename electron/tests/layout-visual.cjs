// Run with Electron, not node. Proves the full layout (real TopBar + Sidebar + chat
// content) holds together at the window's actual minimum size (main.cjs::createWindow
// minWidth/minHeight = 1080x680) — no horizontal overflow, no region overlapping
// another, with a real conversation on screen (not just the empty state).
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-layout-'));
  const home = join(root, 'home');
  const project = join(root, 'project-with-a-fairly-long-name-to-test-truncation');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_LAYOUT_SCREENSHOT_DIR || home;
  let win;
  try {
    const { FoldersService } = await import('../core/folders.mts');
    const { Conversations } = await import('../core/conversations.mts');
    const { SettingsService } = await import('../core/settings.mts');
    const folders = new FoldersService(home);
    const conversations = new Conversations();
    const settings = new SettingsService(home);
    await folders.recordOpened(project);
    // Seed a real-looking conversation so the layout is tested with actual content, not
    // just the empty state.
    await conversations.save(project, 'main', [
      { role: 'user', content: 'Peux-tu créer un fichier de configuration pour moi ?' },
      { role: 'assistant', content: "Bien sûr, je m'en occupe tout de suite." },
      { role: 'tool', tool_call_id: 'call-1', content: 'Créé : config.json' },
      { role: 'assistant', content: 'Voilà, le fichier **config.json** a été créé avec succès dans le projet.' },
    ]);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'list_folders') return folders.list();
      if (request.op === 'activate_folder') {
        const list = await folders.recordOpened(request.payload.folder);
        return { history: await conversations.messages(request.payload.folder, 'main'), folders: list };
      }
      if (request.op === 'open-folder') return project;
      if (request.op === 'global-settings') return settings.publicGlobal();
      if (request.op === 'save-global-settings') return settings.saveGlobal(request.payload.patch);
      throw new Error('opération inattendue dans le test layout : ' + request.op);
    });

    win = new BrowserWindow({
      show: false,
      width: 1080,
      height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 300));

    await win.webContents.executeJavaScript("document.getElementById('oa-open-folder-btn').click()");
    await new Promise(resolve => setTimeout(resolve, 400));

    // BrowserWindow width/height (like main.cjs's own minWidth/minHeight) size the outer
    // frame, not the content area, so the real viewport is a little narrower than 1080 —
    // exactly what a user sees at the app's actual minimum size. Assert against that
    // real viewport, not a fixed 1080 that never actually renders.
    const [innerWidth, innerHeight, scrollWidth] = await win.webContents.executeJavaScript(
      '[window.innerWidth, window.innerHeight, document.documentElement.scrollWidth]',
    );
    assert.ok(innerWidth <= 1080 && innerWidth > 1000, `viewport width is close to the 1080 minimum (got ${innerWidth})`);
    assert.ok(scrollWidth <= innerWidth, `no horizontal overflow at the minimum size (scrollWidth=${scrollWidth}, innerWidth=${innerWidth})`);

    const rects = await win.webContents.executeJavaScript(`
      (() => {
        const topBar = document.querySelector('span.text-purple-500')?.closest('div');
        const sidebarBtn = document.getElementById('oa-open-folder-btn');
        const sidebar = sidebarBtn?.closest('div[style*="width"]');
        const input = document.getElementById('oa-input-ta');
        const rect = el => el ? (() => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; })() : null;
        return {
          topBar: rect(topBar),
          sidebar: rect(sidebar),
          input: rect(input),
        };
      })();
    `);
    assert.ok(rects.topBar, 'the top bar element was found');
    assert.ok(rects.sidebar, 'the sidebar element was found');
    assert.ok(rects.input, 'the input bar element was found');

    // The top bar and the sidebar/main row must not overlap vertically.
    assert.ok(rects.topBar.bottom <= rects.sidebar.top + 1, `top bar (bottom=${rects.topBar.bottom}) does not overlap the row below (top=${rects.sidebar.top})`);
    // The sidebar and the input bar (main column) must not overlap horizontally.
    assert.ok(rects.sidebar.right <= rects.input.left + 1, `sidebar (right=${rects.sidebar.right}) does not overlap the chat column (left=${rects.input.left})`);
    // Everything must stay within the actual viewport.
    assert.ok(rects.input.right <= innerWidth, `nothing renders past the viewport edge (input right=${rects.input.right}, innerWidth=${innerWidth})`);

    const bodyText = await win.webContents.executeJavaScript('document.body.textContent');
    assert.match(bodyText, /config\.json/, 'the seeded conversation actually renders (not the empty state)');
    assert.match(bodyText, /project-with-a-fairly-long-name/, 'the long folder name is present (truncated by CSS, not by content)');

    // capturePage() on a hidden (show:false) window can return a stale frame from
    // before the compositor caught up — force a couple of fresh paints and let them
    // settle before trusting the snapshot.
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 300));
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 300));
    const shot = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'layout-min-size.png'), shot.toPNG());

    process.stdout.write(`PASS layout holds at the minimum window size (1080x680) with a real conversation on screen (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'layout-min-size.png')}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_LAYOUT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL layout visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
