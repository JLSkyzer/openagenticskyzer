// Run with Electron, not node. Proves the update UI through the REAL renderer, preload and worker.mjs
// (behind the same ipcMain.handle('backend-request') shape as main.cjs): the three update ops are answered
// here from a status the test controls — exactly what the real main process does — and every other op goes to
// the real worker. A fake OpenAI-compatible model answers after 3 s so a turn stays visibly running.
//   banner absent while idle → appears when an update is ready → install button disabled during a turn
//   ("après le tour en cours") and enabled afterwards → install click → "Plus tard" dismisses it for the
//   session → Settings › Général shows the version, the state, and the check button works.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-update-visual-'));
  const home = join(root, 'home');
  const project = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));

  const screenshotDir = process.env.OPENAGENT_UPDATE_SCREENSHOT_DIR || home;
  if (process.env.OPENAGENT_UPDATE_SCREENSHOT_DIR) await mkdir(screenshotDir, { recursive: true });
  let win;
  let worker;
  let server;
  try {
    // A model that takes 3 s to answer: the turn is "running" for long enough to be observed.
    server = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: 'Réponse finale.' }, finish_reason: 'stop' }] }));
        }, 3000);
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });

    let status = { enabled: true, currentVersion: '0.2.0', status: 'idle', at: null };
    let checks = 0;
    let installs = 0;
    const pushStatus = next => { status = { ...status, ...next, at: new Date().toISOString() }; win.webContents.send('update-status', status); };

    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'update-status') return status;
      if (request.op === 'update-check') { checks++; pushStatus({ status: 'up-to-date' }); return status; }
      if (request.op === 'update-install-now') {
        if (status.status !== 'ready') throw new Error('Aucune mise à jour prête à installer');
        installs++;
        return { installing: true };
      }
      if (request.op === 'connection-snapshot') {
        return { provider: 'test', model: 'test-model', base_url: connection.base_url, key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: true };
      }
      let outgoing = request;
      if (request.op === 'send') outgoing = { ...request, payload: { ...request.payload, connection } };
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
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
    const has = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const disabled = selector => js(`document.querySelector(${q(selector)})?.disabled === true`);
    const dataOf = (selector, key) => js(`document.querySelector(${q(selector)})?.dataset[${q(key)}] ?? null`);
    const shot = async name => {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await pause(300);
      await capturePng(win);
      await writeFile(join(screenshotDir, name), await capturePng(win));
    };

    // 1. Enter the folder: idle status → no banner.
    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
    await js(`document.querySelector('[data-testid="oa-folder-entry"]').click()`);
    await waitFor(() => has('#oa-input-ta'), { what: 'folder activated' });
    await pause(500);
    assert.equal(await has('[data-testid="oa-update-banner"]'), false, 'no banner while nothing is downloaded');

    // 2. An update becomes ready: the banner appears, install is available.
    pushStatus({ status: 'ready', version: '0.3.0' });
    await waitFor(() => has('[data-testid="oa-update-banner"]'), { what: 'banner shown once ready' });
    assert.match(await text('[data-testid="oa-update-banner"]'), /0\.3\.0/);
    assert.equal(await disabled('#oa-update-install'), false, 'install is enabled while idle');
    assert.equal(await has('[data-testid="oa-update-after-turn"]'), false);

    // 3. A turn is running: install is disabled and says why; it comes back after the turn.
    await js(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'bonjour');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);
    await waitFor(() => has('[data-testid="oa-update-after-turn"]'), { what: 'banner says the turn is running' });
    assert.equal(await disabled('#oa-update-install'), true, 'install is disabled during a turn');
    await shot('update-1-banner.png');
    await waitFor(async () => !(await has('[data-testid="oa-update-after-turn"]')), { timeout: 20000, what: 'turn finished' });
    assert.equal(await disabled('#oa-update-install'), false, 'install is enabled again after the turn');
    assert.match(await js(`Array.from(document.querySelectorAll('[data-testid="oa-assistant-bubble"]')).at(-1)?.textContent || ''`), /Réponse finale/, 'the turn really completed through the worker');

    // 4. Install: the main process is asked exactly once.
    await click('#oa-update-install');
    await waitFor(() => installs === 1, { what: 'install-now reached the main process' });
    assert.equal(installs, 1);

    // 5. "Plus tard" dismisses the banner for the session, even when the same status is pushed again.
    await waitFor(() => has('#oa-update-later'), { what: 'later button' });
    await click('#oa-update-later');
    await waitFor(async () => !(await has('[data-testid="oa-update-banner"]')), { what: 'banner gone after Plus tard' });
    pushStatus({ status: 'ready', version: '0.3.0' });
    await pause(600);
    assert.equal(await has('[data-testid="oa-update-banner"]'), false, 'dismissed for the session');

    // 6. Settings › Général: version, state, manual check.
    await click('#oa-settings-btn');
    await waitFor(() => has('[data-testid="oa-settings-tab"][data-tab="general"]'), { what: 'settings tabs' });
    await click('[data-testid="oa-settings-tab"][data-tab="general"]');
    await waitFor(() => has('[data-testid="oa-update-version"]'), { what: 'update block shown' });
    await waitFor(async () => (await text('[data-testid="oa-update-version"]')) === '0.2.0', { what: 'installed version shown' });
    await waitFor(async () => (await dataOf('[data-testid="oa-update-state"]', 'status')) === 'ready', { what: 'state ready shown' });
    await js(`document.querySelector('[data-testid="oa-update-state"]').scrollIntoView({ block: 'center' })`);
    await shot('update-2-settings.png');
    await click('#oa-update-check');
    await waitFor(async () => checks === 1 && (await dataOf('[data-testid="oa-update-state"]', 'status')) === 'up-to-date', { what: 'check ran and state is up-to-date' });
    assert.equal(checks, 1);

    process.stdout.write(`PASS update UI: banner, disabled during a turn, install/later, settings check through the real renderer (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL update visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
