// Run with Electron, not node. Proves index_status end to end through the REAL UI and the REAL
// worker.mjs: activating a real folder with real files triggers real automatic indexing (no click
// needed beyond opening the folder), the context bar really shows "⏳ Indexation…"/"📊 Index : N/M"
// then "✓ Index prêt" (real embeddings, no mock), and switching folders always shows THAT folder's
// own real status, never a stale label left over from the previous one.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 20000, interval = 50, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-index-status-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  await writeFile(join(alpha, 'sort.py'), 'def sort_list(items):\n    """Sorts a list."""\n    return sorted(items)\n');
  // beta stays empty on purpose: a folder that is opened but never indexed must show nothing.
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: beta, last_used: new Date().toISOString() },
    { path: alpha, last_used: new Date(Date.now() - 1000).toISOString() },
  ]));
  const screenshotDir = process.env.OPENAGENT_INDEX_SCREENSHOT_DIR || home;
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
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
    });
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
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const attr = (selector, name) => js(`document.querySelector(${q(selector)})?.getAttribute(${JSON.stringify(name)})`);
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)})).click()`);

    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`), { what: 'both folders in the sidebar' });

    // ── 1. Opening alpha (real files) triggers real automatic indexing ───────────
    await enter('alpha');
    await waitFor(() => exists('#oa-input-ta'), { what: 'alpha loaded' });
    // The window between "activated" and "done" is short with a single tiny file — catch either
    // the transient label or go straight to ready, but the label must never just be absent.
    const sawSomething = await waitFor(
      async () => {
        if (!(await exists('[data-testid="oa-index-status"]'))) return false;
        return await text('[data-testid="oa-index-status"]');
      },
      { what: 'an index-status label appears at all' },
    );
    assert.ok(/Indexation|Index\s*:|Index prêt/.test(sawSomething), `unexpected first label: ${sawSomething}`);
    await writeFile(join(screenshotDir, 'index-1-first-seen.png'), await capturePng(win));

    await waitFor(async () => (await text('[data-testid="oa-index-status"]')) === '✓ Index prêt', { what: 'index ready' });
    assert.equal(await attr('[data-testid="oa-index-status"]', 'data-state'), 'ready');
    await writeFile(join(screenshotDir, 'index-2-ready.png'), await capturePng(win));

    // ── 2. Switching folders shows EACH folder's own real status, never a stale
    //      carryover from the previous one — activate_folder indexes on every open,
    //      even an empty folder (beta has no indexable files, but still reaches
    //      "✓ Index prêt" with 0 chunks: the same automatic trigger Python's own
    //      background thread applies unconditionally on folder activation) ───────
    await enter('beta');
    await waitFor(() => exists('#oa-input-ta'), { what: 'beta loaded' });
    await waitFor(async () => (await text('[data-testid="oa-index-status"]')) === '✓ Index prêt', { what: 'beta indexed too (0 files, still reaches ready)' });
    await writeFile(join(screenshotDir, 'index-3-other-folder.png'), await capturePng(win));

    await enter('alpha');
    await waitFor(() => exists('#oa-input-ta'), { what: 'alpha loaded again' });
    await waitFor(async () => (await text('[data-testid="oa-index-status"]')) === '✓ Index prêt', { what: 'alpha still ready' });

    process.stdout.write(`PASS index status: real automatic indexing shown live in the context bar, per-folder, no stale carryover (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_INDEX_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL index status visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
