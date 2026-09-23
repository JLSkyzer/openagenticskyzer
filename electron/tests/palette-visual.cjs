// Run with Electron, not node. Proves the command palette end to end through the real UI and the REAL
// worker.mjs (fake model over HTTP): a real Ctrl+K opens it from the input box, the filter and the keyboard
// work, and EVERY command is executed for real — folder dialog, model selector, prompt library, settings,
// project memory (Markdown, empty case), compaction (disk re-read) and clear-history (cancel, confirm, refused
// during a run). Effects are read from the screen and from conversations.json, never from what the palette says.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
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

const ALL_IDS = ['open-folder', 'switch-model', 'clear-history', 'open-settings', 'show-memory', 'open-prompts', 'export', 'compact'];

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-palette-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(join(alpha, '.openagent'), { recursive: true }), mkdir(beta)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: alpha, last_used: new Date().toISOString() },
    { path: beta, last_used: new Date(Date.now() - 1000).toISOString() },
  ]));
  await writeFile(join(alpha, '.openagent', 'memory.md'), '<!-- 2026-09-23 10:00 -->\n# Faits\n- utilise **pnpm**\n- écrit en français\n');
  const screenshotDir = process.env.OPENAGENT_PALETTE_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // Fake model: "réponse N" for a normal turn, a bullet summary for a summary request; normal turns can be held.
    const requests = [];
    const held = [];
    const state = { holdTurn: false, count: 0 };
    let onHeld = null;
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw);
        const isSummary = !body.tools && body.messages.length === 1 && String(body.messages[0].content).startsWith('Résume cette conversation');
        requests.push({ isSummary });
        const answer = () => {
          const content = isSummary ? '- décision : garder la branche A' : `réponse ${++state.count}`;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
        };
        if (!isSummary && state.holdTurn) { held.push(answer); onHeld?.(); } else answer();
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
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
    });
    let nextFolder = alpha;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return nextFolder;
      if (request.op === 'connection-snapshot') {
        return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const needsConnection = request.op === 'send' || request.op === 'compact';
      return callWorker(request.op, needsConnection ? { ...request.payload, connection } : request.payload);
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const bodyText = () => js('document.body.textContent');
    const paletteIds = () => js(`[...document.querySelectorAll('[data-testid="oa-palette-item"]')].map(e => e.dataset.commandId)`);
    const selectedId = () => js(`document.querySelector('[data-testid="oa-palette-item"][data-selected="true"]')?.dataset.commandId || null`);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const activeId = () => js(`document.activeElement?.id || document.activeElement?.tagName`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8'));
    const mainOnDisk = async () => (await disk()).branches.find(b => b.id === 'main').messages;
    // Real keyboard events through Chromium's pipeline (keyDown / keyUp, with modifiers).
    const key = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const ctrlK = () => key('K', ['control']);
    const openPalette = async () => {
      ctrlK();
      await waitFor(() => exists('[data-testid="oa-palette"]'), { what: 'Ctrl+K opens the palette' });
    };
    const runCommand = async id => {
      if (!(await exists('[data-testid="oa-palette"]'))) await openPalette();
      await js(`document.querySelector('[data-testid="oa-palette-item"][data-command-id="${id}"]').click()`);
      await waitFor(async () => !(await exists('[data-testid="oa-palette"]')), { what: 'palette closes when a command is run' });
    };
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)})).click()`);
    const history = count => Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i % 2 === 0 ? 'q' : 'r'}${Math.floor(i / 2) + 1}-${'x'.repeat(200)}` }));
    const mouseClick = (x, y) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };

    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`), { what: 'both folders listed' });

    // ── 1. A real Ctrl+K, from the input box, with no folder open ─────────────────
    await js(`document.getElementById('oa-input-ta').focus()`);
    ctrlK();
    await waitFor(() => exists('[data-testid="oa-palette"]'), { what: 'Ctrl+K from the input box' });
    assert.equal(await js(`document.getElementById('oa-input-ta').value`), '', 'the "k" was not typed into the box');
    assert.equal(await activeId(), 'oa-palette-input', 'the search field has the focus');
    assert.equal(await js(`document.getElementById('oa-palette-input').placeholder`), 'Rechercher une commande…');
    assert.deepEqual(await paletteIds(), ALL_IDS, 'the eight commands, in order');
    const first = (await texts('[data-testid="oa-palette-item"]'))[0];
    assert.match(first, /📂 Ouvrir un dossier/);
    assert.match(first, /Sélectionner un nouveau dossier de projet/);
    await writeFile(join(screenshotDir, 'palette-1-open.png'), await capturePng(win));

    // ── 2. Filter, keyboard selection, reopen resets ─────────────────────────────
    await setValue('#oa-palette-input', 'DOSSIER');
    assert.deepEqual(await paletteIds(), ['open-folder', 'clear-history'], 'label of one, description of the other');
    await setValue('#oa-palette-input', 'zzzz');
    assert.deepEqual(await paletteIds(), []);
    assert.match(await text('[data-testid="oa-palette-empty"]'), /Aucune commande trouvée\./);
    await setValue('#oa-palette-input', '');
    assert.equal(await selectedId(), 'open-folder', 'the first row is selected by default');
    key('Down'); key('Down');
    await waitFor(async () => (await selectedId()) === 'clear-history', { what: 'two ↓' });
    key('Up'); key('Up'); key('Up');
    await waitFor(async () => (await selectedId()) === 'compact', { what: '↑ wraps to the last row' });
    await setValue('#oa-palette-input', 'abc');
    ctrlK();
    await waitFor(async () => (await js(`document.getElementById('oa-palette-input').value`)) === '', { what: 'Ctrl+K again resets the search' });
    assert.equal((await paletteIds()).length, 8);
    // Ctrl+Shift+K is not the shortcut.
    key('Escape');
    await waitFor(async () => !(await exists('[data-testid="oa-palette"]')), { what: 'Escape closes' });
    key('K', ['control', 'shift']);
    await pause(300);
    assert.equal(await exists('[data-testid="oa-palette"]'), false, 'Ctrl+Shift+K does not open it');
    // The backdrop closes it, a click inside does not.
    await openPalette();
    const inputRect = await js(`(() => { const r = document.getElementById('oa-palette-input').getBoundingClientRect(); return { x: Math.round(r.left + 5), y: Math.round(r.top + 5) }; })()`);
    mouseClick(inputRect.x, inputRect.y);
    await pause(250);
    assert.equal(await exists('[data-testid="oa-palette"]'), true, 'a click inside the card keeps it open');
    mouseClick(8, 8);
    await waitFor(async () => !(await exists('[data-testid="oa-palette"]')), { what: 'the backdrop closes it' });

    // ── 3. No folder open: the warnings ──────────────────────────────────────────
    await runCommand('show-memory');
    await waitFor(async () => (await toasts()).some(t => t.text === 'Aucun dossier actif.'), { what: 'memory needs a folder' });
    assert.equal((await toasts()).find(t => t.text === 'Aucun dossier actif.').kind, 'warning');
    assert.equal(await exists('[data-testid="oa-memory-dialog"]'), false, 'no memory window without a folder');
    await runCommand('clear-history');
    await pause(300);
    assert.equal(await exists('[data-testid="oa-clear-confirm"]'), false, 'no confirmation without a folder');
    await runCommand('compact');
    await waitFor(async () => (await toasts()).some(t => t.text === 'Pas assez de messages à compresser.'), { what: 'compact without a folder' });
    await writeFile(join(screenshotDir, 'palette-2-warning.png'), await capturePng(win));

    // ── 4. 📂 Ouvrir un dossier: the real folder flow ────────────────────────────
    await runCommand('open-folder');
    await waitFor(async () => /▸ alpha/.test(await bodyText()), { what: 'alpha is the active folder' });
    assert.equal(await exists('#oa-model-btn'), true);

    // ── 5. 🔄 Changer de modèle / 📋 Bibliothèque / ⚙️ Paramètres open the real windows ──
    await runCommand('switch-model');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { what: 'the model selector opens' });
    await click('#oa-model-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')));
    await runCommand('open-prompts');
    await waitFor(() => exists('[data-testid="oa-prompt-picker"]'), { what: 'the prompt library opens' });
    await click('#oa-prompt-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-prompt-picker"]')));
    await openPalette();
    await setValue('#oa-palette-input', 'paramètres');
    assert.deepEqual(await paletteIds(), ['open-settings']);
    key('Enter'); // keyboard: the single row is selected, Enter runs it
    await waitFor(() => exists('[data-testid="oa-settings-dialog"]'), { what: 'Enter runs the selected command: settings open' });
    await click('#oa-settings-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-settings-dialog"]')));

    // ── 6. 🧠 Mémoire projet: memory.md rendered as Markdown, and the empty case ──
    await runCommand('show-memory');
    await waitFor(() => exists('[data-testid="oa-memory-content"]'), { what: 'memory shown' });
    assert.match(await text('[data-testid="oa-memory-dialog"]'), /🧠 Mémoire projet/);
    assert.equal(await js(`document.querySelector('[data-testid="oa-memory-content"] strong')?.textContent`), 'pnpm', 'the Markdown is rendered (bold), not shown raw');
    assert.match(await text('[data-testid="oa-memory-content"]'), /écrit en français/);
    const shownMemory = await text('[data-testid="oa-memory-content"]');
    assert.doesNotMatch(shownMemory, /2026-09-23|<!--/, `the dated HTML comment is not displayed (shown: ${JSON.stringify(shownMemory)})`);
    await writeFile(join(screenshotDir, 'palette-3-memory.png'), await capturePng(win));
    await click('#oa-memory-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-memory-dialog"]')));
    await enter('beta');
    await waitFor(async () => /▸ beta/.test(await bodyText()), { what: 'beta active' });
    await runCommand('show-memory');
    await waitFor(() => exists('[data-testid="oa-memory-empty"]'), { what: 'empty memory' });
    assert.match(await text('[data-testid="oa-memory-empty"]'), /Aucune mémoire enregistrée pour ce projet\./);
    await click('#oa-memory-close-btn');
    await enter('alpha');
    await waitFor(async () => /▸ alpha/.test(await bodyText()));

    // ── 7. ⚡ Compacter le contexte: a real summary, disk re-read ────────────────
    const reloadWith = async messages => {
      await callWorker('save-messages', { folder: alpha, branchId: 'main', messages });
      await enter('beta'); await pause(400); await enter('alpha');
      await waitFor(async () => (await userBubbles()).length === Math.ceil(messages.length / 2), { what: 'history reloaded' });
    };
    await reloadWith(history(6));
    const before = await mainOnDisk();
    await runCommand('compact');
    await waitFor(async () => (await mainOnDisk()).length === 3, { timeout: 15000, what: 'compaction written' });
    const compacted = await mainOnDisk();
    assert.match(compacted[0].content, /^\*\*\[Résumé de contexte compressé\]\*\*\n\n- décision : garder la branche A/);
    assert.deepEqual(compacted.slice(1), before.slice(-2), 'the last exchange is kept');
    assert.equal(requests.filter(r => r.isSummary).length, 1, 'the model was really asked for a summary');

    // ── 8. 🗑️ Vider l'historique: cancel, then confirm ───────────────────────────
    await reloadWith(history(6));
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'), { what: 'confirmation' });
    assert.match(await text('[data-testid="oa-clear-confirm"]'), /Confirmer l’effacement/);
    assert.ok((await text('[data-testid="oa-clear-confirm"]')).includes(`« ${alpha} » seront effacés`), 'the confirmation names the folder');
    await writeFile(join(screenshotDir, 'palette-4-confirm.png'), await capturePng(win));
    await click('#oa-palette-clear-cancel-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-clear-confirm"]')));
    assert.equal((await mainOnDisk()).length, 6, 'Annuler cleared nothing on disk');
    assert.equal((await userBubbles()).length, 3, 'nor on screen');
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'));
    await click('#oa-palette-clear-ok-btn');
    await waitFor(async () => (await toasts()).some(t => t.text === 'Historique effacé.'), { what: 'success toast survives the chat rebuild' });
    assert.equal((await toasts()).find(t => t.text === 'Historique effacé.').kind, 'positive');
    assert.deepEqual(await mainOnDisk(), [], 'the history is empty on disk');
    await waitFor(async () => (await userBubbles()).length === 0, { what: 'the chat on screen is empty too' });
    await writeFile(join(screenshotDir, 'palette-5-cleared.png'), await capturePng(win));

    // ── 9. Clearing while a run holds the folder is refused, nothing is lost ─────
    await reloadWith(history(4));
    state.holdTurn = true;
    const heldTurn = new Promise(resolve => { onHeld = resolve; });
    await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'en cours');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await heldTurn;
    await waitFor(async () => (await text('#oa-send-btn')) === '■', { what: 'run in flight' });
    const untouched = JSON.stringify(await mainOnDisk());
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'));
    await click('#oa-palette-clear-ok-btn');
    await waitFor(async () => (await toasts()).some(t => t.kind === 'negative' && /en cours/.test(t.text)), { what: 'refused while a run is in flight' });
    assert.equal(JSON.stringify(await mainOnDisk()), untouched, 'nothing was cleared under the running turn');
    await writeFile(join(screenshotDir, 'palette-6-refused.png'), await capturePng(win));
    state.holdTurn = false;
    for (const answer of held.splice(0)) answer();
    await waitFor(async () => (await text('#oa-send-btn')) === '➤', { what: 'run finished' });

    process.stdout.write(`PASS command palette: real Ctrl+K from the input box, filter and keyboard, all 7 commands executed for real, warnings, clear-history cancel / confirm / refused (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    if (!process.env.OPENAGENT_PALETTE_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL palette visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
