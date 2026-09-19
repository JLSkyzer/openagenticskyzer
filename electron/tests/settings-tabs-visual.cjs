// Run with Electron, not node. Proves the Général / Contexte / Permissions tabs end to end
// through the real built renderer and the REAL worker.mjs: values load from the real
// config, real clicks/typing edit them, Enregistrer writes exactly the changed keys to
// config.json, the HuggingFace token is persisted but never comes back to the page, a
// re-opened dialog shows the saved values, and an invalid combination is rejected with
// its message and stores nothing. Only connection-snapshot is faked (the vault lives in
// main.cjs, which this harness does not run).
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const SECRET = 'hf_SECRET-UI';

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-settings-tabs-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
    });
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'm', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id });
      });
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
    const q = key => `[data-setting="${key}"]`;
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const checked = key => js(`document.querySelector(${JSON.stringify(q(key))}).checked`);
    const value = key => js(`document.querySelector(${JSON.stringify(q(key))}).value`);
    const openTab = async id => { await click(`[data-testid="oa-settings-tab"][data-tab="${id}"]`); await pause(150); };
    const config = async () => JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));

    await click('#oa-settings-btn');
    await pause(300);

    // ── Général: defaults come from the real config, then real edits ──────────────
    assert.equal(await js(`document.querySelector('[data-setting="agent_mode"]:checked').value`), 'auto', 'agent mode defaults to auto');
    assert.equal(await checked('restore_last_folder'), true);
    assert.equal(await checked('animations'), true);
    await click(`${q('agent_mode')}[value="plan"]`);
    await click(q('animations'));
    await setValue(q('hf_token'), SECRET);
    assert.equal(await js(`document.querySelector('${q('hf_token')}').type`), 'password', 'the token field is masked by default');
    await click('#oa-hf-toggle');
    assert.equal(await js(`document.querySelector('${q('hf_token')}').type`), 'text', '👁 reveals the token field');
    await click('#oa-hf-toggle');
    assert.match(await js(`document.querySelector('[data-testid="oa-data-dir"]').textContent`), /\.openagent|défaut/i, 'the data directory row shows the default');

    // ── Contexte ──────────────────────────────────────────────────────────────────
    await openTab('context');
    assert.match(await js(`document.querySelector('[data-testid="oa-ctx-caption"]').textContent`), /openrouter.*128,000 tokens/, 'the caption names the active provider and its max');
    assert.match(await js(`document.querySelector('[data-testid="oa-max-tokens-label"]').textContent`), /64,000 tokens/, 'unset limit shows half of the model max, like settings.py');
    await setValue(q('max_tokens'), 32000);
    assert.match(await js(`document.querySelector('[data-testid="oa-max-tokens-label"]').textContent`), /32,000 tokens/, 'the label follows the slider');
    await setValue(q('reserved_tokens'), 4096);
    await click(q('auto_compact'));
    await setValue(q('compact_threshold'), 80);
    assert.match(await js(`document.querySelector('[data-testid="oa-threshold-label"]').textContent`), /Seuil auto-compact : 80%/);
    await click(q('show_context_bar'));
    await setValue(q('session_retention_days'), 90);

    // ── Permissions ───────────────────────────────────────────────────────────────
    await openTab('permissions');
    assert.equal(await value('permission_mode'), 'demander');
    await setValue(q('permission_mode'), 'strict');
    await click(q('files_ask'));

    // ── Enregistrer writes exactly the changed keys ───────────────────────────────
    await click('#oa-settings-save-btn');
    await pause(400);
    assert.match(await js(`document.querySelector('[data-testid="oa-settings-status"]')?.textContent || ''`), /Paramètres sauvegardés/);
    const saved = await config();
    assert.deepEqual(
      { agent_mode: saved.agent_mode, animations: saved.animations, hf_token: saved.hf_token, max_tokens: saved.max_tokens, reserved_tokens: saved.reserved_tokens, auto_compact: saved.auto_compact, compact_threshold: saved.compact_threshold, show_context_bar: saved.show_context_bar, session_retention_days: saved.session_retention_days, permission_mode: saved.permission_mode, files_ask: saved.files_ask },
      { agent_mode: 'plan', animations: false, hf_token: SECRET, max_tokens: 32000, reserved_tokens: 4096, auto_compact: false, compact_threshold: 80, show_context_bar: false, session_retention_days: 90, permission_mode: 'strict', files_ask: true },
      'every edited value reached config.json',
    );
    assert.equal('restore_last_folder' in saved, false, 'a key the user did not touch is not written');
    const leaked = await js(`(() => document.body.innerHTML.includes(${JSON.stringify(SECRET)}) || Array.from(document.querySelectorAll('input')).some(i => i.value.includes(${JSON.stringify(SECRET)})))()`);
    assert.equal(leaked, false, 'the token is nowhere in the page after saving');

    // ── Re-open: the saved values come back from the real backend ─────────────────
    await click('#oa-settings-close-btn');
    await pause(100);
    await click('#oa-settings-btn');
    await pause(300);
    assert.equal(await js(`document.querySelector('[data-setting="agent_mode"]:checked').value`), 'plan');
    assert.equal(await checked('animations'), false);
    assert.match(await js(`document.querySelector('${q('hf_token')}').placeholder`), /configuré/i, 'a stored token is shown as configured, never as its value');
    await openTab('context');
    assert.equal(await value('max_tokens'), '32000');
    assert.equal(await value('reserved_tokens'), '4096');
    assert.equal(await checked('auto_compact'), false);
    assert.equal(await value('session_retention_days'), '90');
    await openTab('permissions');
    assert.equal(await value('permission_mode'), 'strict');
    assert.equal(await checked('files_ask'), true);

    // ── An invalid combination is rejected, shown, and stores nothing ─────────────
    await openTab('context');
    await setValue(q('max_tokens'), 3000);
    await setValue(q('reserved_tokens'), 4096);
    await click('#oa-settings-save-btn');
    await pause(400);
    assert.match(await js(`document.querySelector('[data-testid="oa-settings-error"]')?.textContent || ''`), /tokens réservés/, 'the backend message is shown to the user');
    assert.equal((await config()).max_tokens, 32000, 'the rejected save changed nothing on disk');

    // Real paint check, then keep the screenshot for a human look.
    await pause(300);
    await writeFile(join(screenshotDir, 'settings-context.png'), (await win.webContents.capturePage()).toPNG());

    process.stdout.write(`PASS settings tabs: real edits persist exactly, token never returns, invalid save rejected (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'settings-context.png')}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL settings tabs visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
