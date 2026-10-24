// Run with Electron, not node. Proves the Général / Contexte / Permissions tabs end to end
// through the real built renderer and the REAL worker.mjs: values load from the real
// config, real clicks/typing edit them, Enregistrer writes exactly the changed keys to
// config.json, the HuggingFace token is persisted but never comes back to the page, a
// re-opened dialog shows the saved values, and an invalid combination is rejected with
// its message and stores nothing. The model window comes from the real worker's model-status
// (no .gguf active: MIN_LOCAL_CONTEXT, 16 384).
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng, withTimeout } = require('./capture-helper.cjs');

/** Polls `fn` until it returns a truthy value; fails naming `what` after `timeout` ms. Every wait on the page goes
 * through it: the panels render only once the worker has sent the settings, and a fixed pause before a query fails
 * whenever the worker is slower than the pause (the 2026-10-24 closure run, under load). */
async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout} ms: ${what}`);
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
    // Bounded: a renderer that never answers fails the run naming the script, instead of hanging until the runner's kill.
    const js = async (code, ms = 15000) => {
      try { return await withTimeout(win.webContents.executeJavaScript(code), ms, 'executeJavaScript'); }
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
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const openTab = async id => {
      await click(`[data-testid="oa-settings-tab"][data-tab="${id}"]`);
      await waitFor(async () => (await js(`document.querySelector('[data-testid="oa-settings-panel"]')?.dataset.tab ?? null`)) === id && await exists('[data-setting]'), { what: `the ${id} panel is shown` });
    };
    // The dialog renders its panels only once the worker has answered the settings (SettingsDialog: draft.loaded):
    // before that, no [data-setting] exists at all — the loading state can never pass for the loaded one.
    const settingsLoaded = () => waitFor(() => exists(`${q('agent_mode')}:checked`), { what: 'the settings loaded from the worker (agent_mode checked)' });
    const statusText = () => js(`document.querySelector('[data-testid="oa-settings-status"]')?.textContent || ''`);
    const config = async () => JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));

    await waitFor(() => exists('#oa-settings-btn'), { what: 'the app rendered its settings button' });
    await click('#oa-settings-btn');
    await settingsLoaded();

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
    // The row shows the real data_home (since 3e113ad), which here is the isolated home this test created.
    assert.equal((await js(`document.querySelector('[data-testid="oa-data-dir"]').textContent`)).toLowerCase(), (await realpath(home)).toLowerCase(), 'the data directory row shows the isolated data home');

    // « Journal des tours » (core/turn-log.mts): the three levels, « Complet (défaut) » shown on a fresh home.
    assert.deepEqual(
      await js(`[...document.querySelector('${q('turn_log')}').options].map(o => [o.value, o.textContent])`),
      [['full', 'Complet (défaut)'], ['metadata', 'Sans contenu'], ['off', 'Désactivé']],
      'the turn log offers its three levels, in French',
    );
    assert.equal(await js(`(() => { const s = document.querySelector('${q('turn_log')}'); return s.options[s.selectedIndex].textContent; })()`), 'Complet (défaut)');
    await setValue(q('turn_log'), 'metadata');
    assert.equal(await value('turn_log'), 'metadata', 'the select follows the choice');
    // « Ouvrir le dossier des journaux »: present and usable — never clicked here, it would open Explorer.
    await js(`document.querySelector('[data-testid="oa-open-turn-logs"]').scrollIntoView({ block: 'center' })`);
    await pause(150);
    const openLogs = await js(`(() => {
      const button = document.querySelector('[data-testid="oa-open-turn-logs"]');
      if (!button) return null;
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: button.textContent.trim(), disabled: button.disabled, width: box.width, height: box.height, onTop: !!hit && button.contains(hit) };
    })()`);
    assert.ok(openLogs, 'the « Ouvrir le dossier des journaux » button exists');
    assert.equal(openLogs.text, 'Ouvrir le dossier des journaux');
    assert.equal(openLogs.disabled, false, 'it is enabled');
    assert.ok(openLogs.width > 0 && openLogs.height > 0 && openLogs.onTop, `it is visible and nothing covers it: ${JSON.stringify(openLogs)}`);
    await writeFile(join(screenshotDir, 'settings-general.png'), await capturePng(win));

    // ── Contexte ──────────────────────────────────────────────────────────────────
    await openTab('context');
    assert.match(await js(`document.querySelector('[data-testid="oa-ctx-caption"]').textContent`), /^Max du modèle actif \(aucun modèle\) : 16,384 tokens$/, 'no .gguf active: the caption says so, with MIN_LOCAL_CONTEXT as the max');
    assert.equal(await js(`document.querySelector('${q('max_tokens')}').max`), '16384', 'the slider stops at the engine window: max_tokens can only cap it');
    assert.match(await js(`document.querySelector('[data-testid="oa-max-tokens-label"]').textContent`), /8,192 tokens/, 'unset limit shows half of the model max (16 384 / 2), like settings.py');
    await setValue(q('max_tokens'), 12000);
    assert.match(await js(`document.querySelector('[data-testid="oa-max-tokens-label"]').textContent`), /12,000 tokens/, 'the label follows the slider');
    await setValue(q('reserved_tokens'), 4096);
    await click(q('auto_compact'));
    await setValue(q('compact_threshold'), 80);
    assert.match(await js(`document.querySelector('[data-testid="oa-threshold-label"]').textContent`), /Seuil auto-compact : 80%/);
    await click(q('show_context_bar'));
    await setValue(q('session_retention_days'), 90);
    assert.equal(
      await js(`document.querySelector('[data-testid="oa-retention-note"]')?.textContent`),
      'L’historique d’un projet inutilisé au-delà de cette durée est archivé dans le dossier de données (retention-archive), jamais supprimé.',
      'the retention choice says history is archived, not deleted (R2)',
    );

    // ── Permissions ───────────────────────────────────────────────────────────────
    await openTab('permissions');
    assert.equal(await value('permission_mode'), 'demander');
    assert.equal(await checked('files_ask'), true, 'writes ask by default (2026-10-03)');
    const permissionsText = await js(`document.querySelector('[data-testid="oa-settings-dialog"]').textContent`);
    assert.ok(permissionsText.includes('Écritures : fichiers, git, mémoire'), 'the switch names everything it covers');
    assert.equal(permissionsText.includes('Écriture / suppression de fichiers'), false, 'the old label is gone');
    await writeFile(join(screenshotDir, 'settings-permissions.png'), await capturePng(win));
    await setValue(q('permission_mode'), 'strict');
    await click(q('files_ask'));

    // ── Enregistrer writes exactly the changed keys ───────────────────────────────
    await click('#oa-settings-save-btn');
    // Empty before this first save: only the worker's answer to it writes « Paramètres sauvegardés ».
    await waitFor(async () => /Paramètres sauvegardés/.test(await statusText()), { what: 'the save is confirmed' });
    const saved = await config();
    assert.deepEqual(
      { agent_mode: saved.agent_mode, animations: saved.animations, hf_token: saved.hf_token, max_tokens: saved.max_tokens, reserved_tokens: saved.reserved_tokens, auto_compact: saved.auto_compact, compact_threshold: saved.compact_threshold, show_context_bar: saved.show_context_bar, session_retention_days: saved.session_retention_days, permission_mode: saved.permission_mode, files_ask: saved.files_ask, turn_log: saved.turn_log },
      { agent_mode: 'plan', animations: false, hf_token: SECRET, max_tokens: 12000, reserved_tokens: 4096, auto_compact: false, compact_threshold: 80, show_context_bar: false, session_retention_days: 90, permission_mode: 'strict', files_ask: false, turn_log: 'metadata' },
      'every edited value reached config.json',
    );
    assert.equal('restore_last_folder' in saved, false, 'a key the user did not touch is not written');
    const leaked = await js(`(() => document.body.innerHTML.includes(${JSON.stringify(SECRET)}) || Array.from(document.querySelectorAll('input')).some(i => i.value.includes(${JSON.stringify(SECRET)})))()`);
    assert.equal(leaked, false, 'the token is nowhere in the page after saving');

    // ── Re-open: the saved values come back from the real backend ─────────────────
    await click('#oa-settings-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-settings-dialog"]')), { what: 'the dialog closed' });
    await click('#oa-settings-btn');
    // A new dialog, a new draft: its panels come back only with the worker's answer.
    await settingsLoaded();
    assert.equal(await js(`document.querySelector('[data-setting="agent_mode"]:checked').value`), 'plan');
    assert.equal(await checked('animations'), false);
    assert.match(await js(`document.querySelector('${q('hf_token')}').placeholder`), /configuré/i, 'a stored token is shown as configured, never as its value');
    assert.equal(await value('turn_log'), 'metadata', 'the saved turn-log level comes back');
    await openTab('context');
    assert.equal(await value('max_tokens'), '12000');
    assert.equal(await value('reserved_tokens'), '4096');
    assert.equal(await checked('auto_compact'), false);
    assert.equal(await value('session_retention_days'), '90');
    await openTab('permissions');
    assert.equal(await value('permission_mode'), 'strict');
    assert.equal(await checked('files_ask'), false, 'the unticked switch was saved and comes back');

    // ── An invalid combination is rejected, shown, and stores nothing ─────────────
    await openTab('context');
    await setValue(q('max_tokens'), 3000);
    await setValue(q('reserved_tokens'), 4096);
    await click('#oa-settings-save-btn');
    // No error in this reopened dialog before this save: only the worker's refusal shows one.
    await waitFor(async () => /tokens réservés/.test(await js(`document.querySelector('[data-testid="oa-settings-error"]')?.textContent || ''`)), { what: 'the backend message is shown to the user' });
    assert.equal((await config()).max_tokens, 12000, 'the rejected save changed nothing on disk');

    // Real paint check, then keep the screenshot for a human look.
    await writeFile(join(screenshotDir, 'settings-context.png'), await capturePng(win));

    process.stdout.write(`PASS settings tabs: real edits persist exactly, token never returns, invalid save rejected (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${join(screenshotDir, 'settings-general.png')}, ${join(screenshotDir, 'settings-context.png')}\n`);
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
