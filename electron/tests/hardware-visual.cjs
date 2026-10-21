// Run with Electron, not node. The « 🖥️ Matériel » settings tab end to end, through the real built renderer and the
// REAL worker.mjs (hardware and offload, Tasks 7 and 11): the lines are the worker's own hardware-info in French,
// « Relire » really re-reads, « Contexte des modèles locaux » is saved by Enregistrer into config.json; the CUDA pack
// (a small synthetic pack built here with writePack, served by a local server, never downloaded for real) shows its
// size before any click, is cancelled, installed (D-CUDA-4: then a restart is offered) and removed; « Moteur » offers
// one restart. « Redémarrer maintenant » sends restart-app to the main process, answered here by this harness, which
// only counts it (the real relaunch is proven headless by tests/restart-app.cjs). OPENAGENT_HOME is a fresh temporary
// folder: the user's data is never read or written.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
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

/** Serves the pack's parts from `dir` on 127.0.0.1; `server.bytesPerTick` (512, or 0 for no throttle) can change
 * between two downloads: the worker's download source is fixed at its start. */
async function startPackServer(dir) {
  const timers = new Set();
  const server = http.createServer(async (req, res) => {
    const name = decodeURIComponent((req.url || '/').replace(/^\//, ''));
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); res.end(); return; }
    let bytes;
    try { bytes = await readFile(join(dir, name)); } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    const step = server.bytesPerTick;
    if (!step) { res.end(bytes); return; }
    let offset = 0;
    const tick = () => {
      if (res.destroyed) return;
      res.write(bytes.subarray(offset, offset + step));
      offset += step;
      if (offset >= bytes.length) { res.end(); return; }
      const timer = setTimeout(() => { timers.delete(timer); tick(); }, 50);
      timers.add(timer);
    };
    tick();
  });
  server.bytesPerTick = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${server.address().port}/`;
  server.stop = async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  };
  return server;
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-hardware-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR || home;
  let win;
  let worker;
  let packServer;
  let restartRequests = 0;
  try {
    const { hardwareLines } = await import(pathToFileURL(join(__dirname, '..', 'renderer-src', 'src', 'components', 'settings', 'hardware-view.ts')).href);
    const { formatBytes } = await import(pathToFileURL(join(__dirname, '..', 'core', 'units.mts')).href);
    const { writePack } = await import(pathToFileURL(join(__dirname, '..', 'core', 'cuda-pack-format.mts')).href);
    // A synthetic pack of this engine's version: random bytes (gzip cannot shrink them), so a throttled download
    // lasts long enough to be cancelled. No NVIDIA file: nothing here is ever loaded.
    const engine = JSON.parse(readFileSync(join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version;
    const sources = [];
    for (const [file, bytes] of [
      ['node_modules/@node-llama-cpp/win-x64-cuda/package.json', Buffer.from('{"name":"@node-llama-cpp/win-x64-cuda"}\n')],
      ['cuda-runtime/cublas64_13.dll', randomBytes(200_000)],
      ['cuda-runtime/LICENSE.txt', Buffer.from('NVIDIA licence (synthetic).\n')],
    ]) {
      const source = join(root, 'src', ...file.split('/'));
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, bytes);
      sources.push({ path: file, source });
    }
    const packDir = join(root, 'pack');
    const manifest = await writePack(sources, packDir, { nodeLlamaCppVersion: engine, chunkBytes: 65536 });
    packServer = await startPackServer(packDir);
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), {
      env: { ...process.env, OPENAGENT_HOME: home },
      workerData: { cudaPackManifest: join(packDir, 'manifest.json'), cudaPackBaseUrl: packServer.url },
    });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      // Events (the CUDA pack's progress and end) reach the page as main.cjs sends them.
      if (message.type === 'event' && win && !win.isDestroyed()) win.webContents.send('backend-message', message);
    });
    const callWorker = (op, payload = {}) => {
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ op, payload, id });
      });
    };
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'restart-app') { restartRequests++; return { restarting: true }; }
      return callWorker(request.op, request.payload);
    });

    win = new BrowserWindow({
      show: true,
      opacity: 0,
      focusable: false,
      width: 1080,
      height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const lineText = field => js(`document.querySelector('[data-testid="oa-hardware-line"][data-field="${field}"]')?.textContent ?? null`);
    const reads = () => js(`document.querySelector('[data-testid="oa-hardware"]')?.dataset.reads ?? null`);

    // ── 1. Settings → Matériel ──────────────────────────────────────────────────────
    await click('#oa-settings-btn');
    await waitFor(() => exists('[data-testid="oa-settings-tab"][data-tab="hardware"]'), { what: 'the Matériel tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="hardware"]');
    await waitFor(async () => (await js(`document.querySelector('[data-testid="oa-settings-panel"]')?.dataset.tab`)) === 'hardware', { what: 'the Matériel panel is shown' });

    // ── 2. The lines appear once the worker has answered (none before: the tab renders no line until then) ─
    await waitFor(() => exists('[data-testid="oa-hardware-line"][data-field="backend"]'), { timeout: 120000, what: 'the first hardware-info answer' });
    assert.equal(await reads(), '1', 'one read on opening the tab');

    // ── 3. Each line is the worker's own hardware-info in French ───────────────────────
    const expected = hardwareLines(await callWorker('hardware-info', { refresh: false }));
    for (const field of ['backend', 'gpu', 'cpu']) {
      assert.equal(await lineText(field), expected.find(line => line.field === field).text, `the ${field} line matches hardware-info`);
    }
    assert.match(await lineText('ram'), /^RAM : .+ au total, .+ libres$/, 'free memory moves: the RAM line is matched by shape');
    if (expected.some(line => line.field === 'vram')) {
      assert.match(await lineText('vram'), /^VRAM : .+ au total, .+ libres$/, 'free memory moves: the VRAM line is matched by shape');
    } else {
      assert.equal(await lineText('vram'), null, 'no card in use: no VRAM line');
    }

    // ── 4. « Relire » really reads again ────────────────────────────────────────────────
    await click('[data-testid="oa-hardware-refresh-btn"]');
    await waitFor(async () => (await reads()) === '2', { timeout: 60000, what: 'the second read (data-reads="2")' });

    // ── 5. « Contexte des modèles locaux »: 64k, saved by Enregistrer like every tab ──────
    assert.equal(await js(`document.querySelector('[data-setting="local_context"]').value`), '32768', 'the default is 32k');
    await js(`(() => {
      const el = document.querySelector('[data-setting="local_context"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '65536');
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await click('#oa-settings-save-btn');
    await waitFor(async () => /Paramètres sauvegardés/.test(await js(`document.querySelector('[data-testid="oa-settings-status"]')?.textContent || ''`)), { what: 'the save is confirmed' });
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.local_context, 65536, 'config.json holds local_context: 65536');

    // ── 6. One capture for a human look ─────────────────────────────────────────────────
    await writeFile(join(screenshotDir, 'settings-hardware.png'), await capturePng(win));

    // ── 7. The CUDA pack: its size before any click (NVIDIA), or hidden ─────────────────────
    const cudaState = () => js(`document.querySelector('[data-testid="oa-cuda-pack"]')?.dataset.state ?? null`);
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    await waitFor(async () => (await cudaState()) !== null, { timeout: 60000, what: 'the CUDA pack block' });
    const { nvidia } = await callWorker('hardware-info', { refresh: false });
    let cudaSummary = 'no NVIDIA card: the CUDA block hidden';
    if (!nvidia) {
      assert.equal(await cudaState(), 'hidden');
      assert.equal(await exists('[data-testid="oa-cuda-download-btn"]'), false);
    } else {
      assert.equal(await cudaState(), 'absent');
      assert.equal(await text('[data-testid="oa-cuda-download-btn"]'), `Télécharger le pack CUDA (${formatBytes(manifest.downloadBytes)})`, 'the size before any click');

      // ── 8. Download (throttled), then « Annuler »: nothing left behind ──────────────────
      packServer.bytesPerTick = 512;
      await click('[data-testid="oa-cuda-download-btn"]');
      await waitFor(async () => (await cudaState()) === 'installing', { what: 'data-state="installing" after the click' });
      assert.equal(await exists('[data-testid="oa-cuda-progress"]'), true, 'a progress bar while installing');
      await waitFor(() => exists('[data-testid="oa-cuda-cancel-btn"]'), { what: 'the cancel button' });
      await click('[data-testid="oa-cuda-cancel-btn"]');
      // Reached only through the cancelled event: « installing » was asserted just before.
      await waitFor(async () => (await cudaState()) === 'absent', { timeout: 30000, what: 'data-state="absent" after « Annuler »' });
      const left = await readdir(join(home, 'cuda-pack')).catch(() => []);
      assert.deepEqual(left.filter(name => name.startsWith('.staging-')), [], 'no staging folder left in <home>/cuda-pack');
      assert.equal(await exists('[data-testid="oa-cuda-error"]'), false, 'a cancel is not an error');

      // ── 9. Download without throttle: installed, then D-CUDA-4 = restart ────────────────
      packServer.bytesPerTick = 0;
      await click('[data-testid="oa-cuda-download-btn"]');
      // The state before the click is « absent »: « restart » can only come from the finished install.
      await waitFor(async () => (await cudaState()) === 'restart', { timeout: 60000, what: 'data-state="restart" after the install' });
      assert.equal(await text('[data-testid="oa-cuda-restart-btn"]'), 'Redémarrer maintenant');
      assert.equal(await exists('[data-testid="oa-restart-btn"]'), false, "one restart button in the tab: the CUDA block's");
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await capturePng(win);
      await writeFile(join(screenshotDir, 'settings-hardware-cuda.png'), await capturePng(win));

      // ── 10. No uninstall button in « restart »: through the page's bridge, then « Relire » ──
      await js(`window.openagent.request({ op: 'cuda-pack-uninstall', payload: {} })`);
      const readsBeforeRefresh = Number(await reads());
      await click('[data-testid="oa-hardware-refresh-btn"]');
      // Both reads of « Relire »: the pack's state, and hardware-info (whose restartRequired the next step relies on).
      await waitFor(async () => (await cudaState()) === 'absent' && Number(await reads()) > readsBeforeRefresh, { timeout: 60000, what: 'data-state="absent" and hardware-info read again after the uninstall' });
      cudaSummary = 'CUDA pack sized, cancelled, installed (restart), removed';
    }

    // ── 11. « Moteur »: « Processeur seul » offers one restart; saved by it; back to « Automatique » ──
    const restartShown = () => exists('[data-testid="oa-restart-btn"]');
    const selectBackend = value => js(`(() => {
      const el = document.querySelector('[data-testid="oa-gpu-backend"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    assert.equal(await js(`document.querySelector('[data-testid="oa-gpu-backend"]').value`), 'auto', 'the default is auto');
    assert.equal(await restartShown(), false, 'nothing to restart for yet');
    await selectBackend('cpu');
    await waitFor(restartShown, { what: 'the restart offer after choosing « Processeur seul »' });
    assert.equal(await text('[data-testid="oa-restart"] span'), "Le changement de moteur s'applique au prochain démarrage de l'app.");
    const readsBefore = Number(await reads());
    await click('[data-testid="oa-restart-btn"]');
    await waitFor(() => restartRequests === 1, { what: 'restart-app reached the main process' });
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).gpu_backend, 'cpu', 'the choice was saved before the restart');
    // The save makes the tab read again: then the worker itself says a restart is needed.
    await waitFor(async () => Number(await reads()) > readsBefore, { timeout: 60000, what: 'the read after the save' });
    await selectBackend('auto');
    await pause(300);
    assert.equal(await restartShown(), true, '« auto » selected, but « cpu » is saved: still to restart');
    await click('#oa-settings-save-btn');
    // True before this save (asserted just above): only the save of « auto » and the read after it hide the offer.
    await waitFor(async () => !(await restartShown()), { timeout: 60000, what: 'the restart offer gone once « auto » is saved' });
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).gpu_backend, 'auto');
    assert.equal(restartRequests, 1, 'restart-app sent once');

    process.stdout.write(`PASS hardware tab: the worker's own machine lines, a real re-read, local_context saved; ${cudaSummary}; one engine restart offer (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'settings-hardware.png')}\n`);
  } finally {
    win?.destroy();
    await worker?.terminate();
    await packServer?.stop();
    if (!process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL hardware tab visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
