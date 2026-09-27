// Run with Electron, not node. Proves the sidebar's git branch/status widget end to end through the
// real UI and the REAL worker.mjs 'git-status' op against REAL git repositories (real `git` subprocess
// calls, no mocking of git itself). 'open-folder' is stubbed to return a real path directly (native
// file dialog, same convention as every other visual test here) — everything after that is real.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

const run = promisify(execFile);
const sh = async (args, cwd) => (await run('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();

async function waitFor(fn, { timeout = 60000, interval = 100, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-gitstatus-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  for (const repo of [alpha, beta]) {
    await sh(['init', '-b', 'main'], repo);
    await sh(['config', 'user.name', 'Test'], repo);
    await sh(['config', 'user.email', 'test@example.com'], repo);
    await sh(['config', 'commit.gpgsign', 'false'], repo);
    await writeFile(join(repo, 'README.md'), '# Test\n');
    await sh(['add', 'README.md'], repo);
    await sh(['commit', '-m', 'initial'], repo);
  }

  const screenshotDir = process.env.OPENAGENT_GITSTATUS_SCREENSHOT_DIR || home;
  const pageMessages = [];
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
    let openDialogPath = alpha;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return openDialogPath;
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
    win.webContents.on('console-message', event => pageMessages.push(`[${event.level}] ${event.message}`));
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
    const attr = (selector, name) => js(`document.querySelector(${q(selector)})?.getAttribute(${q(name)})`);
    // CSS.escape isn't available in this stripped-down page-script context, and Windows temp
    // paths contain backslashes — build the attribute selector on the Node side instead.
    const activeEntrySelector = folderPath => `[data-testid="oa-folder-entry"][data-active="true"][data-path="${folderPath.replace(/\\/g, '\\\\')}"]`;
    async function openAndWaitActive(folderPath) {
      openDialogPath = folderPath;
      await click('#oa-open-folder-btn');
      // Both repos share the branch name "main" — waiting on the widget's text alone cannot tell
      // the two apart. Wait for the folder list's own active marker first, which activateFolder's
      // real round trip only sets once that op has actually resolved.
      await waitFor(() => exists(activeEntrySelector(folderPath)), { timeout: 15000, what: `${folderPath} becomes active` });
    }

    // ── 1. Opening alpha (clean git repo) shows the widget with its branch, no dirty dot ─────────────
    await openAndWaitActive(alpha);
    await waitFor(() => exists('[data-testid="oa-git-status"]'), { timeout: 15000, what: 'git widget appears for alpha' });
    assert.match(await text('[data-testid="oa-git-status"]'), /⎇ main/);
    assert.equal(await attr('[data-testid="oa-git-status"]', 'data-dirty'), 'false');
    await writeFile(join(screenshotDir, 'gitstatus-1-clean.png'), await capturePng(win));

    // ── 2. Switching to beta (a different clean repo) re-fetches — same branch name, still clean ────
    await openAndWaitActive(beta);
    await waitFor(() => exists('[data-testid="oa-git-status"]'), { what: 'widget still present for beta' });
    assert.equal(await attr('[data-testid="oa-git-status"]', 'data-dirty'), 'false');

    // ── 3. Dirtying alpha on disk, then switching back to it, shows the dirty indicator ──────────────
    await writeFile(join(alpha, 'README.md'), '# Test\n\nchangé\n');
    await openAndWaitActive(alpha);
    await waitFor(async () => (await attr('[data-testid="oa-git-status"]', 'data-dirty')) === 'true', { what: 'alpha now shows dirty' });
    assert.match(await text('[data-testid="oa-git-status"]'), /●/);
    await writeFile(join(screenshotDir, 'gitstatus-2-dirty.png'), await capturePng(win));

    // ── 4. A folder that is not a git repo at all shows no widget ────────────────────────────────────
    const gamma = join(root, 'gamma');
    await mkdir(gamma);
    await openAndWaitActive(gamma);
    await pause(300);
    assert.equal(await exists('[data-testid="oa-git-status"]'), false, 'no widget for a non-git folder');

    process.stdout.write(`PASS git status widget: real branch/dirty via the real worker + real git across 3 folders (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'gitstatus-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-10))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_GITSTATUS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL git-status visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
