// Run with Electron, not node. Proves the permission banner end to end through the real UI + real
// worker.mjs, with the DEFAULT settings (nothing overridden): since 2026-10-03 a file write asks first.
//  1. create_file → banner « Toujours (cette session) » / Autoriser / Refuser; nothing written before the
//     click on Autoriser, written right after;
//  2. a shell command is shown IN FULL, and Refuser really refuses;
//  3. « Toujours (cette session) » on create_file: the next create_file runs without a banner, and nothing
//     is written to the project settings.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" in this environment unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
// Destroying the window in `finally` would otherwise quit the app before a failing run gets to
// print its error — keep the process alive until the test exits explicitly.
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

// Long on purpose, and its END is what a truncated banner would hide from the user.
const LONG_COMMAND = `node -e "require('fs').writeFileSync('shell-ran.txt','x')" && echo ligne-tres-longue-pour-depasser-soixante-caracteres && echo FIN-COMMANDE-VISIBLE`;
const ALWAYS = 'Toujours (cette session)';

const toolCall = (id, name, args) => ({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
// The scripted model: request N (1-based) gets SCRIPT[N]; any other request ends the turn with "Fait.".
const SCRIPT = {
  1: toolCall('call-1', 'create_file', { path: 'notes.md', content: 'contenu confirme' }),
  3: toolCall('call-2', 'run_command', { command: LONG_COMMAND }),
  5: toolCall('call-3', 'create_file', { path: 'second.md', content: 'toujours' }),
  7: toolCall('call-4', 'create_file', { path: 'third.md', content: 'sans bandeau' }),
};

async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

async function fileExists(file) {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-permission-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_PERMISSION_SCREENSHOT_DIR || home;
  const targetFile = join(project, 'notes.md');
  let win;
  let server;
  let worker;
  try {
    // No setting is written: the defaults are what is under test.
    let requestCount = 0;
    server = createServer((request, response) => {
      const index = ++requestCount;
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(SCRIPT[index] ?? { choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
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
    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'global-settings') return { theme: 'dark', accent_color: '#3b82f6', onboarding_done: true };
      if (request.op === 'save-global-settings') return {};
      let outgoing = request;
      if (request.op === 'send') outgoing = { ...request, payload: { ...request.payload, connection } };
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
      });
    });

    // show:true + opacity:0 — a hidden window stops painting and its captures go stale (lessons 2026-09-19).
    win = new BrowserWindow({
      show: true,
      opacity: 0,
      width: 1100,
      height: 760,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));

    const js = code => win.webContents.executeJavaScript(code);
    const type = text => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const bannerShown = () => js("!!document.querySelector('[data-testid=\"oa-permission-banner\"]')");
    const bannerGone = async () => !(await bannerShown());
    const bannerText = () => js("document.querySelector('[data-testid=\"oa-permission-banner\"]')?.textContent || ''");
    const clickBanner = label => js(`(() => {
      const btn = Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button')).find(b => b.textContent === ${JSON.stringify(label)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    const idle = () => js("document.getElementById('oa-send-btn')?.textContent === '➤'");
    const capture = async name => {
      // Two frames, then a warm-up capture thrown away: the kept one shows the CURRENT state (lessons 2026-10-02).
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await capturePng(win);
      await writeFile(join(screenshotDir, name), await capturePng(win));
    };

    await js("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(() => js("document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false"));

    // ── 1. create_file asks by default ────────────────────────────────────────────
    await type('crée notes.md');
    await waitFor(bannerShown);
    assert.match(await bannerText(), /create_file/, 'the banner names the real tool awaiting confirmation');
    assert.match(await bannerText(), /notes\.md/, 'the banner shows the real (truncated) arguments');
    const labels = await js(`Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button')).map(b => b.textContent)`);
    assert.deepEqual(labels, [ALWAYS, 'Autoriser', 'Refuser'], '« Toujours » says it lasts for this session');
    assert.equal(await fileExists(targetFile), false, 'nothing was written to disk before the user decided');
    await capture('permission-1-banner.png');
    assert.ok(await clickBanner('Autoriser'), 'the Autoriser button was found and clicked');
    await waitFor(bannerGone);
    await waitFor(async () => (await js("Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''")).includes('Fait'));
    await capture('permission-2-approved.png');
    assert.equal(await readFile(targetFile, 'utf8'), 'contenu confirme', 'the file was written, with the real content, only after Autoriser');
    await waitFor(idle);

    // ── 2. A shell command is shown IN FULL: approving what you cannot read is not consent ──
    await type('lance la commande');
    await waitFor(bannerShown);
    const shellBanner = await bannerText();
    assert.match(shellBanner, /run_command/, 'the banner names the shell tool');
    assert.ok(shellBanner.includes('FIN-COMMANDE-VISIBLE'), `the END of the command is visible before approving (got: ${shellBanner})`);
    assert.equal(await fileExists(join(project, 'shell-ran.txt')), false, 'nothing ran before the decision');
    assert.ok(await clickBanner('Refuser'), 'the Refuser button was found and clicked');
    await waitFor(bannerGone);
    await waitFor(idle);
    assert.equal(await fileExists(join(project, 'shell-ran.txt')), false, 'a refused command never runs');

    // ── 3. « Toujours (cette session) »: remembered for this tool, written nowhere ──
    await type('crée second.md');
    await waitFor(bannerShown);
    assert.match(await bannerText(), /second\.md/);
    assert.ok(await clickBanner(ALWAYS), 'the « Toujours (cette session) » button was found and clicked');
    await waitFor(() => fileExists(join(project, 'second.md')));
    await waitFor(idle);
    await type('crée third.md');
    // With the default asking, a banner would block this write forever: the file appearing IS the proof.
    await waitFor(() => fileExists(join(project, 'third.md')), { timeout: 8000 });
    await waitFor(idle);
    assert.equal(await bannerShown(), false, 'no banner the second time in this session');
    const projectConfig = await readFile(join(project, '.openagent', 'config.json'), 'utf8').catch(() => '{}');
    assert.equal(projectConfig.includes('files_ask'), false, 'nothing was written to the project settings');
    await capture('permission-3-always.png');

    process.stdout.write(`PASS permission banner: writes ask by default, Autoriser / Refuser / Toujours (cette session) act for real (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (!process.env.OPENAGENT_PERMISSION_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL permission visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
