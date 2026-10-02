// Run with Electron, not node. Proves the per-project trust UI end to end through the REAL UI and
// the REAL worker.mjs (a real project plugin on disk whose top-level code writes a marker file):
// the banner lists the real content and nothing runs before approval; "Faire confiance" loads it;
// "Retirer la confiance" brings the banner back; "Ignorer" survives a reload.
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
const exists = file => readFile(file).then(() => true, () => false);

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-trust-visual-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const marker = join(root, 'plugin-ran.txt');
  await Promise.all([mkdir(home), mkdir(join(alpha, 'tools'), { recursive: true })]);
  await writeFile(join(alpha, 'tools', 'marker.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: 'trust_plugin', description: 'ok', properties: {}, execute: async () => 'ok' }]; }
`);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  const screenshotDir = process.env.OPENAGENT_TRUST_SCREENSHOT_DIR || home;
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
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'connection-snapshot') {
        return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
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
    const has = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const enterAlpha = async () => {
      await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
      await js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes('alpha'))?.click()`);
      await waitFor(() => has('#oa-input-ta'), { what: 'alpha activated' });
    };
    const openTools = async () => {
      await click('#oa-settings-btn');
      await waitFor(() => has('[data-testid="oa-settings-tab"][data-tab="tools"]'), { what: 'Outils tab exists' });
      await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
      await waitFor(() => has('[data-testid="oa-trust-state"]'), { what: 'trust row shown' });
    };
    const closeSettings = () => click('#oa-settings-close-btn');

    // ── The banner lists the real plugin; nothing has run ─────────────────────────────────────
    await enterAlpha();
    await waitFor(() => has('[data-testid="oa-trust-banner"]'), { what: 'trust banner shown' });
    assert.match(await text('[data-testid="oa-trust-plugin"]'), /tools\/marker\.mjs/);
    await writeFile(join(screenshotDir, 'trust-1-banner.png'), await capturePng(win));
    await openTools();
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'pending');
    assert.match(await text('[data-testid="oa-plugin-untrusted"]'), /tools\/marker\.mjs/);
    assert.equal(await exists(marker), false, 'the project plugin never ran before approval');
    await closeSettings();

    // ── "Faire confiance": the plugin is really loaded ────────────────────────────────────────
    await click('#oa-trust-banner-approve');
    await waitFor(async () => !(await has('[data-testid="oa-trust-banner"]')), { what: 'banner gone after approval' });
    await openTools();
    await waitFor(() => has('[data-testid="oa-plugin-entry"]'), { what: 'the plugin is loaded' });
    assert.match(await text('[data-testid="oa-plugin-entry"]'), /trust_plugin/);
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'trusted');
    assert.equal(await exists(marker), true, 'the plugin really ran once trusted');
    await writeFile(join(screenshotDir, 'trust-2-trusted.png'), await capturePng(win));

    // ── "Retirer la confiance": pending again, banner back ────────────────────────────────────
    await click('#oa-trust-revoke');
    await waitFor(() => js(`document.querySelector('[data-testid="oa-trust-state"]')?.dataset.state === 'pending'`), { what: 'pending after revoke' });
    await closeSettings();
    // The banner and the Outils tab are mounted together: no reload may be needed to see the change.
    await waitFor(() => has('[data-testid="oa-trust-banner"]'), { what: 'banner back after revoke in Outils, without a reload' });
    assert.match(await text('[data-testid="oa-trust-plugin"]'), /tools\/marker\.mjs/);

    // ── Approving in Outils while the banner is shown: the banner must go, without a reload ──
    await openTools();
    await click('#oa-trust-approve');
    await waitFor(() => js(`document.querySelector('[data-testid="oa-trust-state"]')?.dataset.state === 'trusted'`), { what: 'trusted after approving in Outils' });
    await waitFor(async () => !(await has('[data-testid="oa-trust-banner"]')), { what: 'banner gone while settings is still open' });
    await closeSettings();
    await pause(500);
    assert.equal(await has('[data-testid="oa-trust-banner"]'), false, 'no stale banner after approving in Outils');

    // ── Back to pending (revoke in Outils), then "Ignorer" is remembered across a reload ─────
    await openTools();
    await click('#oa-trust-revoke');
    await waitFor(() => js(`document.querySelector('[data-testid="oa-trust-state"]')?.dataset.state === 'pending'`), { what: 'pending after the second revoke' });
    await closeSettings();
    await waitFor(() => has('[data-testid="oa-trust-banner"]'), { what: 'banner back after the second revoke, without a reload' });
    await click('#oa-trust-banner-ignore');
    await waitFor(async () => !(await has('[data-testid="oa-trust-banner"]')), { what: 'banner gone after ignore' });
    await win.webContents.reload();
    await pause(500);
    await enterAlpha();
    await pause(1500);
    assert.equal(await has('[data-testid="oa-trust-banner"]'), false, '"Ignorer" survives a reload');
    await openTools();
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'ignored');
    await writeFile(join(screenshotDir, 'trust-3-ignored.png'), await capturePng(win));

    process.stdout.write(`PASS trust banner: real plugin listed and never run before approval, trust/revoke/ignore through the real worker (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_TRUST_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL trust visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
