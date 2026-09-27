// Run with Electron, not node. Proves the "Tester le token" HuggingFace flow end to end through
// the real UI and the REAL worker.mjs 'test-hf-token' op — a real HTTP request leaves the worker,
// hits a local fake HuggingFace server (via OPENAGENT_HF_ENDPOINT, a test-only seam; production
// always calls the real huggingface.co), and the resulting toast is read back from the real DOM.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { createServer } = require('node:http');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-hftoken-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);

  // Stands in for huggingface.co: valid only for the one token this test types in.
  let hfShouldAccept = true;
  const hfServer = createServer((request, response) => {
    const ok = hfShouldAccept && request.headers.authorization === 'Bearer hf_TestToken123';
    response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(ok ? { name: 'killian-dev' } : { error: 'invalid' }));
  });
  await new Promise((resolve, reject) => { hfServer.once('error', reject); hfServer.listen(0, '127.0.0.1', resolve); });
  const hfPort = hfServer.address().port;

  const screenshotDir = process.env.OPENAGENT_HFTOKEN_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), {
      env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_HF_ENDPOINT: `http://127.0.0.1:${hfPort}/api/whoami-v2` },
    });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
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
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const setInput = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    await click('#oa-settings-btn');
    await waitFor(() => js(`!!document.querySelector('[data-setting="hf_token"]')`), { what: 'General tab (default) shows the HF token field' });

    // ── 1. A valid token: real network round trip, success toast with the real account name ──────
    await setInput('[data-setting="hf_token"]', 'hf_TestToken123');
    await click('#oa-hf-test-btn');
    await waitFor(async () => /killian-dev/.test(await text('[data-testid="oa-toast"]')), { what: 'success toast with account name' });
    assert.equal(await js(`document.querySelector('[data-testid="oa-toast"]')?.dataset.kind`), 'positive');
    await writeFile(join(screenshotDir, 'hftoken-1-success.png'), await capturePng(win));

    // ── 2. The same token, now rejected server-side: failure toast, no crash ───────────────────────
    hfShouldAccept = false;
    await click('#oa-hf-test-btn');
    await waitFor(async () => /❌/.test(await text('[data-testid="oa-toast"]')), { what: 'failure toast' });
    assert.equal(await js(`document.querySelector('[data-testid="oa-toast"]')?.dataset.kind`), 'negative');
    await writeFile(join(screenshotDir, 'hftoken-2-failure.png'), await capturePng(win));

    // ── 3. An empty token never reaches the network: immediate warning toast ───────────────────────
    await setInput('[data-setting="hf_token"]', '');
    await click('#oa-hf-test-btn');
    await waitFor(async () => /vide/i.test(await text('[data-testid="oa-toast"]')), { what: 'empty-token warning toast' });

    process.stdout.write(`PASS HF token test: real network round trip through the real worker, success/failure/empty (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'hftoken-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    await new Promise(resolve => hfServer.close(resolve));
    if (!process.env.OPENAGENT_HFTOKEN_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL hf-token visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
