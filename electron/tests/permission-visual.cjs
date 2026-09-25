// Run with Electron, not node. Proves the permission banner end to end through the real
// UI + real worker.mjs: with files_ask forced true for the project, a create_file call
// must NOT write anything until the user clicks "Autoriser" on a real click, and must
// write for real immediately after.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
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

// Long on purpose, and its END is what a truncated banner would hide from the user.
const LONG_COMMAND = `node -e "require('fs').writeFileSync('shell-ran.txt','x')" && echo ligne-tres-longue-pour-depasser-soixante-caracteres && echo FIN-COMMANDE-VISIBLE`;

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
    // Force confirmation for writes on this project — default settings auto-allow them,
    // which would make this test meaningless.
    const { SettingsService } = await import('../core/settings.mts');
    await new SettingsService(home).saveProject(project, { override_permissions: true, files_ask: true });

    let requestCount = 0;
    server = createServer((request, response) => {
      requestCount++;
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        if (requestCount === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'notes.md', content: 'contenu confirme' }) } }] },
              finish_reason: 'tool_calls',
            }],
          }));
        } else if (requestCount === 3) {
          // Second message: a shell command well past the 60 characters the banner used to keep.
          response.end(JSON.stringify({
            choices: [{
              message: { content: '', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: LONG_COMMAND }) } }] },
              finish_reason: 'tool_calls',
            }],
          }));
        } else {
          response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
        }
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

    win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));

    await win.webContents.executeJavaScript("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(() => win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false",
    ));

    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'crée notes.md');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);

    await waitFor(() => win.webContents.executeJavaScript("!!document.querySelector('[data-testid=\"oa-permission-banner\"]')"));
    const bannerText = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-permission-banner\"]')?.textContent",
    );
    assert.match(bannerText, /create_file/, 'the banner names the real tool awaiting confirmation');
    assert.match(bannerText, /notes\.md/, 'the banner shows the real (truncated) arguments');

    assert.equal(await fileExists(targetFile), false, 'nothing was written to disk before the user decided');

    const shotBanner = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'permission-1-banner.png'), shotBanner.toPNG());

    // Click the real "Autoriser" button (find by its visible label, like a user would).
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const btn = Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button'))
          .find(b => b.textContent === 'Autoriser');
        if (!btn) return false;
        btn.click();
        return true;
      })();
    `);
    assert.ok(clicked, 'the Autoriser button was found and clicked');

    await waitFor(() => win.webContents.executeJavaScript(
      "!document.querySelector('[data-testid=\"oa-permission-banner\"]')",
    ));

    await waitFor(async () => {
      const text = await win.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''",
      );
      return text.includes('Fait');
    });

    const shotDone = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'permission-2-approved.png'), shotDone.toPNG());

    const created = await readFile(targetFile, 'utf8');
    assert.equal(created, 'contenu confirme', 'the file was actually written, with the real content, only after Autoriser was clicked');

    // ── A shell command must be shown IN FULL: approving what you cannot read is not consent ──
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'lance la commande');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);
    await waitFor(() => win.webContents.executeJavaScript("!!document.querySelector('[data-testid=\"oa-permission-banner\"]')"));
    const shellBanner = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-permission-banner\"]')?.textContent",
    );
    assert.match(shellBanner, /run_command/, 'the banner names the shell tool');
    assert.ok(shellBanner.includes('FIN-COMMANDE-VISIBLE'), `the END of the command is visible before approving (got: ${shellBanner})`);
    assert.equal(await fileExists(join(project, 'shell-ran.txt')), false, 'nothing ran before the decision');
    const refused = await win.webContents.executeJavaScript(`
      (() => {
        const btn = Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button')).find(b => b.textContent === 'Refuser');
        if (!btn) return false;
        btn.click();
        return true;
      })();
    `);
    assert.ok(refused, 'the Refuser button was found and clicked');
    await waitFor(() => win.webContents.executeJavaScript("!document.querySelector('[data-testid=\"oa-permission-banner\"]')"));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await fileExists(join(project, 'shell-ran.txt')), false, 'a refused command never runs');

    process.stdout.write(`PASS permission banner blocks the write until Autoriser is clicked, then it happens for real (Electron ${process.versions.electron})\n`);
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
