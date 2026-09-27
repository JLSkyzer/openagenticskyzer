// Run with Electron, not node. Proves "Changer le dossier…" end to end through the real UI and
// the REAL worker.mjs: real settings/folders files pre-existing on disk, a real click reveals the
// inline panel pre-filled with the real resolved data home, a real click on "Appliquer" runs the
// real migrate-data-dir op, and the files really move on disk to the new directory.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-datadir-visual-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  const newDataDir = join(root, 'nouveau-disque', 'openagent-data');
  await Promise.all([mkdir(home), mkdir(project)]);
  // Real pre-existing data, like a real user's install: a folder history entry and a non-default setting.
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));
  await writeFile(join(home, 'config.json'), JSON.stringify({ theme: 'light' }));

  const screenshotDir = process.env.OPENAGENT_DATADIR_SCREENSHOT_DIR || home;
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
    let pickedDataDir = newDataDir;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'pick-data-dir') return pickedDataDir;
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
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const inputValue = selector => js(`document.querySelector(${q(selector)})?.value || ''`);

    await click('#oa-settings-btn');
    await waitFor(() => exists('[data-testid="oa-data-dir"]'), { what: 'General tab shows the data-dir box' });
    // The real resolved home (settings.publicGlobal()'s data_home) shows up, not a placeholder.
    await waitFor(async () => (await text('[data-testid="oa-data-dir"]')).includes(home.replace(/\\/g, '\\')) || (await text('[data-testid="oa-data-dir"]')) === home, { timeout: 10000, what: 'real data_home shown' });
    await writeFile(join(screenshotDir, 'datadir-1-before.png'), await capturePng(win));

    // ── A real click opens the inline panel, pre-filled with the real current home ────────────────
    await click('#oa-data-dir-open-btn');
    await waitFor(() => exists('[data-testid="oa-data-dir-input"]'), { what: 'inline migration panel opens' });
    assert.equal(await inputValue('[data-testid="oa-data-dir-input"]'), home);

    // ── The native picker (stubbed) fills the field, a real click on Appliquer migrates for real ──
    await click('#oa-data-dir-browse-btn');
    await waitFor(async () => (await inputValue('[data-testid="oa-data-dir-input"]')) === newDataDir, { what: 'picked path fills the field' });
    await click('#oa-data-dir-apply-btn');
    await waitFor(async () => /migré/.test(await text('[data-testid="oa-toast"]')), { timeout: 10000, what: 'migration success toast' });
    await writeFile(join(screenshotDir, 'datadir-2-migrated.png'), await capturePng(win));

    // ── The files REALLY moved on disk ───────────────────────────────────────────────────────────
    const movedConfig = JSON.parse(await readFile(join(newDataDir, 'config.json'), 'utf8'));
    assert.equal(movedConfig.theme, 'light');
    const movedFolders = JSON.parse(await readFile(join(newDataDir, 'folders.json'), 'utf8'));
    assert.equal(movedFolders.length, 1);
    await assert.rejects(readFile(join(home, 'config.json'), 'utf8'), 'the old location no longer has it');

    // ── The fixed redirect at the ORIGINAL home now points at the new one ───────────────────────────
    const { resolveDataHome } = await import('../core/data-dir.mts');
    assert.equal(await resolveDataHome(home), newDataDir);

    process.stdout.write(`PASS data-dir migration: real click, real worker, real files moved on disk (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'datadir-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_DATADIR_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL data-dir visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
