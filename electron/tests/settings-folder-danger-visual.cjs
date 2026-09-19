// Run with Electron, not node. Proves the Dossier and Danger tabs end to end through the
// real built renderer and the REAL worker.mjs: per-project settings save to the project's
// own config.json, the custom prompt editor works (Escape closes only the modal), clearing
// the history empties the disk AND the visible chat, removing the folder drops it from the
// sidebar without touching its files, and resetting the global settings restores the
// defaults on disk and in the live theme. Only connection-snapshot is faked.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-settings-folder-'));
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
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
    });
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'm', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      return callWorker(request.op, request.payload);
    });

    // A real history to clear: 2 messages on main plus a fork copy.
    await callWorker('save-messages', { folder: project, messages: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'coucou-historique' }] });
    await callWorker('fork', { folder: project, source: 'main', count: 2, label: 'essai' });

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
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const bodyText = () => js('document.body.textContent');
    const openTab = async id => { await click(`[data-testid="oa-settings-tab"][data-tab="${id}"]`); await pause(200); };
    const projectConfig = async () => JSON.parse(await readFile(join(project, '.openagent', 'config.json'), 'utf8'));
    const conversation = async () => JSON.parse(await readFile(join(project, '.openagent', 'conversations.json'), 'utf8'));

    // Open the real folder from the sidebar: its saved history is on screen.
    await click('#oa-open-folder-btn');
    await pause(500);
    assert.match(await bodyText(), /coucou-historique/, 'the folder history is shown in the chat');

    await click('#oa-settings-btn');
    await pause(300);
    assert.equal(await text('[data-testid="oa-settings-tab"][data-tab="folder"]'), '📁 projet');

    // ── Dossier ───────────────────────────────────────────────────────────────────
    await openTab('folder');
    assert.match(await text('[data-testid="oa-settings-panel"]'), /Paramètres de projet/);
    assert.match(await text('[data-testid="oa-folder-path"]'), /projet$/, 'the active folder path is shown');
    assert.equal(await js(`document.querySelector('[data-project-setting="agent_mode"]').value`), 'inherit');
    assert.equal(await js(`document.querySelector('[data-project-setting="ignored_patterns"]').value`), 'node_modules/, .env, dist/');
    await setValue('[data-project-setting="agent_mode"]', 'plan');
    await setValue('[data-project-setting="ignored_patterns"]', 'node_modules/, .env, dist/, *.log');
    await click('#oa-folder-save-btn');
    await pause(400);
    assert.match(await text('[data-testid="oa-folder-status"]'), /Paramètres dossier sauvegardés/);
    const saved = await projectConfig();
    assert.equal(saved.agent_mode, 'plan');
    assert.equal(saved.ignored_patterns, 'node_modules/, .env, dist/, *.log');
    assert.equal('custom_prompt' in saved, false, 'an untouched key is not written');

    // Prompt editor: Escape closes only the modal, Enregistrer writes immediately.
    await click('#oa-prompt-edit-btn');
    await pause(150);
    assert.equal(await exists('[data-testid="oa-modal"]'), true, 'the prompt editor opens');
    await js(`document.getElementById('oa-prompt-textarea').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await pause(150);
    assert.equal(await exists('[data-testid="oa-modal"]'), false, 'Escape closes the modal');
    assert.equal(await exists('[data-testid="oa-settings-dialog"]'), true, 'and only the modal, the settings dialog stays open');
    await click('#oa-prompt-edit-btn');
    await pause(150);
    await setValue('#oa-prompt-textarea', 'Réponds toujours en français.');
    await click('#oa-prompt-cancel-btn');
    await pause(150);
    assert.equal('custom_prompt' in (await projectConfig()), false, 'Annuler stores nothing');
    await click('#oa-prompt-edit-btn');
    await pause(150);
    await setValue('#oa-prompt-textarea', 'Réponds toujours en français.');
    await click('#oa-prompt-save-btn');
    await pause(400);
    assert.equal(await exists('[data-testid="oa-modal"]'), false, 'Enregistrer closes the modal');
    assert.equal((await projectConfig()).custom_prompt, 'Réponds toujours en français.', 'the prompt is on disk immediately');

    // Re-open the dialog: the values come back from the project's config.json.
    await click('#oa-settings-close-btn');
    await pause(100);
    await click('#oa-settings-btn');
    await pause(300);
    await openTab('folder');
    assert.equal(await js(`document.querySelector('[data-project-setting="agent_mode"]').value`), 'plan');
    assert.equal(await js(`document.querySelector('[data-project-setting="ignored_patterns"]').value`), 'node_modules/, .env, dist/, *.log');

    // ── Danger: clear the history (cancel first, then confirm) ────────────────────
    await openTab('danger');
    await click('#oa-danger-clear-btn');
    await pause(150);
    assert.match(await text('[data-testid="oa-modal"]'), /Confirmer la suppression[\s\S]*projet/);
    await writeFile(join(screenshotDir, 'settings-danger-confirm.png'), await capturePng(win));
    await click('#oa-confirm-cancel-btn');
    await pause(150);
    assert.equal((await conversation()).branches.length, 2, 'Annuler cleared nothing');
    await click('#oa-danger-clear-btn');
    await pause(150);
    await click('#oa-confirm-ok-btn');
    await pause(500);
    assert.match(await text('[data-testid="oa-danger-status"]'), /Historique effacé \(4 message/);
    const cleared = await conversation();
    assert.equal(cleared.branches.length, 1, 'forks are gone on disk');
    assert.deepEqual(cleared.branches[0].messages, [], 'main is empty on disk');
    assert.doesNotMatch(await bodyText(), /coucou-historique/, 'the visible chat was emptied too, not only the disk');

    // ── Danger: remove the folder from the sidebar ────────────────────────────────
    assert.equal(await js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length`), 1);
    await click('#oa-danger-remove-btn');
    await pause(500);
    assert.match(await text('[data-testid="oa-danger-status"]'), /Dossier retiré de la sidebar/);
    assert.equal(await js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length`), 0, 'the sidebar entry is gone');
    assert.equal(await text('[data-testid="oa-settings-tab"][data-tab="folder"]'), '📁 Dossier', 'no active folder any more');
    assert.doesNotMatch(await bodyText(), /▸ projet/, 'the top bar no longer names the folder');
    assert.deepEqual(JSON.parse(await readFile(join(home, 'folders.json'), 'utf8')), [], 'folders.json is empty');
    assert.ok((await stat(project)).isDirectory(), 'the project files were never touched');

    // ── Danger: reset the global settings ─────────────────────────────────────────
    await openTab('appearance');
    await click('#oa-theme-light-btn');
    await pause(300);
    assert.equal(await js(`document.documentElement.getAttribute('data-theme')`), 'light');
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).theme, 'light');
    await openTab('danger');
    await click('#oa-danger-reset-btn');
    await pause(150);
    await click('#oa-confirm-cancel-btn');
    await pause(150);
    assert.equal(await js(`document.documentElement.getAttribute('data-theme')`), 'light', 'Annuler resets nothing');
    await click('#oa-danger-reset-btn');
    await pause(150);
    await click('#oa-confirm-ok-btn');
    await pause(500);
    assert.match(await text('[data-testid="oa-danger-status"]'), /Paramètres réinitialisés/);
    assert.equal(await js(`document.documentElement.getAttribute('data-theme')`), 'dark', 'the live theme went back to the default');
    assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), {}, 'nothing custom is left in config.json');

    process.stdout.write(`PASS folder + danger tabs: per-project settings persist, history/sidebar/reset act for real on disk and on screen (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'settings-danger-confirm.png')}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_SETTINGS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL settings folder/danger visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
