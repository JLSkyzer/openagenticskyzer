// Run with Electron, not node. Proves the sidebar's "📚 Base de connaissances" end to end through
// the REAL UI and the REAL worker.mjs: it is a working feature here, unlike sidebar.py's own
// "+ Ajouter un document" button, which (verified by reading the whole Python file) only ever
// shows a ui.notify() hint — add_to_knowledge is never called anywhere in that repo. A real click
// opens the native picker (stubbed to a real file, same convention as 'pick-gguf' in every other
// visual test here — nothing can drive a real OS dialog), the file is really read and embedded,
// the list and a real ✕ removal are both proven against the real store on disk.
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-knowledge-ui-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  const docPath = join(root, 'notes.md');
  await writeFile(docPath, '# Mes notes\n\nUn vrai document ajouté par un vrai clic.');
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const screenshotDir = process.env.OPENAGENT_KNOWLEDGE_SCREENSHOT_DIR || home;
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
      // A real native dialog cannot be driven from a test: stubbed to a real file path, same
      // convention as 'pick-gguf'/'open-folder' in every other visual test in this project.
      if (request.op === 'pick-knowledge-file') return docPath;
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
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);

    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });

    // ── 1. Collapsed by default, opens on click, empty at first ──────────────────
    assert.equal(await exists('[data-testid="oa-knowledge-empty"]'), false, 'collapsed: nothing rendered yet');
    await click('#oa-knowledge-toggle');
    await waitFor(() => exists('[data-testid="oa-knowledge-empty"]'), { what: 'expanded, empty' });
    assert.match(await text('[data-testid="oa-knowledge-empty"]'), /Aucun document/);
    await writeFile(join(screenshotDir, 'knowledge-1-empty.png'), await capturePng(win));

    // ── 2. A real click opens the (stubbed) native picker and really adds the file ─
    await click('#oa-knowledge-add-btn');
    await waitFor(() => exists('[data-testid="oa-knowledge-entry"]'), { what: 'notes.md listed' });
    const entries = await texts('[data-testid="oa-knowledge-entry"]');
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^notes\.md/);
    const onDisk = await callWorker('knowledge-list', {});
    assert.deepEqual(onDisk, ['notes.md'], 'really persisted, not just shown on screen');
    await writeFile(join(screenshotDir, 'knowledge-2-added.png'), await capturePng(win));

    // ── 3. It survives a reload of the section (real data, not local-only state) ──
    await click('#oa-knowledge-toggle'); // collapse
    await click('#oa-knowledge-toggle'); // expand again, re-reads from the worker
    await waitFor(() => exists('[data-testid="oa-knowledge-entry"]'), { what: 'notes.md still listed after reopening' });

    // ── 4. A real ✕ click removes it, from disk too ───────────────────────────────
    await click('[data-testid="oa-knowledge-remove"]');
    await waitFor(() => exists('[data-testid="oa-knowledge-empty"]'), { what: 'empty again' });
    assert.deepEqual(await callWorker('knowledge-list', {}), [], 'really removed from the real store');
    await writeFile(join(screenshotDir, 'knowledge-3-removed.png'), await capturePng(win));

    process.stdout.write(`PASS knowledge section: real native picker, real add/list/remove, persisted on disk (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_KNOWLEDGE_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL knowledge visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
