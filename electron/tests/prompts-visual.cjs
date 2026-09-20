// Run with Electron, not node. Proves the prompt library end to end through the real UI and the REAL
// worker.mjs: a real click on ✦ lists the ten defaults, the filter works on name and description only,
// choosing a prompt fills the input with the folder name and replaces a draft, "/" in an empty box opens the
// library WITHOUT typing the slash (real key events), Escape / ✕ / the backdrop close it, and prompts.json
// written by hand in the data directory is picked up at once (invalid → defaults).
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
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

const DEFAULT_IDS = ['refactor', 'tests', 'explain', 'pr_desc', 'debug', 'optimize', 'security', 'review', 'document', 'translate'];
const REVIEW = 'Effectue une revue de code complète de mon-projet.\nPriorise : CRITIQUE > IMPORTANT > SUGGESTION. Référence les numéros de ligne.';
const DEBUG = 'Analyse cette erreur et propose un fix avec explication :\n\n';

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-prompts-'));
  const home = join(root, 'home');
  const project = join(root, 'mon-projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));
  const screenshotDir = process.env.OPENAGENT_PROMPTS_SCREENSHOT_DIR || home;
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
        worker.postMessage({ op: request.op, payload: request.payload, id });
      });
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
    const itemIds = () => js(`[...document.querySelectorAll('[data-testid="oa-prompt-item"]')].map(e => e.dataset.promptId)`);
    const setFilter = value => js(`(() => {
      const el = document.getElementById('oa-prompt-filter');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const inputValue = () => js(`document.getElementById('oa-input-ta').value`);
    const setInput = value => js(`(() => { const el = document.getElementById('oa-input-ta'); el.value = ${JSON.stringify(value)}; el.focus(); })()`);
    const activeId = () => js(`document.activeElement?.id || document.activeElement?.tagName`);
    const openPicker = async () => {
      await click('#oa-prompt-btn');
      await waitFor(() => exists('[data-testid="oa-prompt-picker"]'), { what: 'picker opens' });
      await waitFor(async () => (await itemIds()).length > 0 || await exists('[data-testid="oa-prompt-empty"]'), { what: 'picker loaded' });
    };
    const closedNow = async () => !(await exists('[data-testid="oa-prompt-picker"]'));
    // Real key presses: the key goes through Chromium's own keyboard pipeline (keydown, then char).
    const press = key => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      win.webContents.sendInputEvent({ type: 'char', keyCode: key });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    };
    const mouseClick = (x, y) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };

    await waitFor(() => exists('[data-testid="oa-folder-entry"]'), { what: 'folder listed' });
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-prompt-btn'), { what: '✦ button' });

    // ── 1. The ✦ button and the ten defaults ─────────────────────────────────────
    assert.equal(await text('#oa-prompt-btn'), '✦');
    assert.equal(await js(`document.getElementById('oa-prompt-btn').title`), 'Bibliothèque de prompts');
    await openPicker();
    assert.match(await text('[data-testid="oa-prompt-picker"]'), /Bibliothèque de prompts/);
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'the ten defaults, in order');
    const firstRow = await text('[data-testid="oa-prompt-item"]');
    assert.match(firstRow, /🔧/);
    assert.match(firstRow, /Refactoriser/);
    assert.match(firstRow, /Améliore la lisibilité et la structure du code/);
    assert.equal(await activeId(), 'oa-prompt-filter', 'the filter field has the focus when the picker opens');
    assert.equal(await js(`document.getElementById('oa-prompt-filter').placeholder`), 'Filtrer…');
    await writeFile(join(screenshotDir, 'prompts-1-picker.png'), await capturePng(win));

    // ── 2. The filter: name and description, any case; NOT the template ──────────
    await setFilter('test');
    assert.deepEqual(await itemIds(), ['tests'], 'matches "Écrire les tests"');
    await setFilter('PERFORMANCES');
    assert.deepEqual(await itemIds(), ['optimize'], 'matches a description, whatever the case');
    await setFilter('pytest');
    assert.deepEqual(await itemIds(), [], '"pytest" only appears in a template: not searched');
    assert.match(await text('[data-testid="oa-prompt-empty"]'), /Aucun prompt ne correspond/);
    await writeFile(join(screenshotDir, 'prompts-2-empty-filter.png'), await capturePng(win));
    await setFilter('');
    assert.equal((await itemIds()).length, 10, 'clearing the filter brings everything back');

    // ── 3. Choosing a prompt fills the input with the folder name ────────────────
    await js(`document.querySelector('[data-testid="oa-prompt-item"][data-prompt-id="review"]').click()`);
    await waitFor(closedNow, { what: 'picker closes after choosing' });
    assert.equal(await inputValue(), REVIEW, '{filename} became the name of the active folder');
    assert.equal(await activeId(), 'oa-input-ta', 'the input has the focus back');
    assert.equal(await js(`document.getElementById('oa-input-ta').selectionStart`), REVIEW.length, 'caret at the end');
    await writeFile(join(screenshotDir, 'prompts-3-applied.png'), await capturePng(win));

    // ── 4. It REPLACES a typed draft; a template that ends open can be continued ──
    await setInput('mon brouillon');
    await openPicker();
    await js(`document.querySelector('[data-testid="oa-prompt-item"][data-prompt-id="debug"]').click()`);
    await waitFor(closedNow);
    assert.equal(await inputValue(), DEBUG, 'the draft was replaced, as in the original');
    assert.equal(await js(`document.getElementById('oa-input-ta').selectionStart`), DEBUG.length);

    // ── 5. "/" in an empty box opens the library and is NOT typed ────────────────
    await setInput('');
    press('/');
    await waitFor(() => exists('[data-testid="oa-prompt-picker"]'), { what: '"/" opens the picker' });
    await pause(200);
    assert.equal(await inputValue(), '', 'no stray "/" was typed into the box');
    assert.equal(await js(`document.getElementById('oa-prompt-filter').value`), '', 'nor in the filter');
    // Escape closes it (real key), and the box is focused again.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await waitFor(closedNow, { what: 'Escape closes' });
    assert.equal(await activeId(), 'oa-input-ta');
    assert.equal(await inputValue(), '', 'closing without choosing leaves the box empty');
    // In a box that already has text, "/" is an ordinary character.
    await setInput('chemin');
    press('/');
    await pause(300);
    assert.equal(await exists('[data-testid="oa-prompt-picker"]'), false, 'no picker when the box is not empty');
    assert.equal(await inputValue(), 'chemin/', 'the slash is typed normally');

    // ── 6. ✕ and the backdrop close it; a click inside the card does not ─────────
    await openPicker();
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow, { what: '✕ closes' });
    await openPicker();
    const title = await js(`(() => { const r = document.querySelector('[data-testid="oa-prompt-picker"] span').getBoundingClientRect(); return { x: Math.round(r.left + 5), y: Math.round(r.top + 5) }; })()`);
    mouseClick(title.x, title.y);
    await pause(300);
    assert.equal(await exists('[data-testid="oa-prompt-picker"]'), true, 'a click inside the card keeps it open');
    mouseClick(8, 8);
    await waitFor(closedNow, { what: 'the backdrop closes' });

    // ── 7. prompts.json written by hand is used at once; invalid → defaults ──────
    const promptsFile = join(home, 'prompts.json');
    await writeFile(promptsFile, JSON.stringify([
      { id: 'a', name: 'Alpha', icon: '🔧', description: 'Premier prompt', template: 'Relis {filename} puis {filename}' },
      { id: 'b', name: 'Bravo', template: 'Sans icône ni description' },
    ]));
    await openPicker();
    assert.deepEqual(await itemIds(), ['a', 'b'], 'the user file replaces the defaults, no restart');
    assert.match(await text('[data-testid="oa-prompt-item"][data-prompt-id="b"]'), /📝/, 'a missing icon shows 📝');
    await writeFile(join(screenshotDir, 'prompts-4-custom.png'), await capturePng(win));
    await js(`document.querySelector('[data-testid="oa-prompt-item"][data-prompt-id="a"]').click()`);
    await waitFor(closedNow);
    assert.equal(await inputValue(), 'Relis mon-projet puis mon-projet', 'every {filename} is replaced');

    await writeFile(promptsFile, '{ pas du json');
    await openPicker();
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'a corrupt file falls back on the defaults');
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);

    await writeFile(promptsFile, JSON.stringify(['not', 'a', 'dict']));
    await openPicker();
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'the shape that crashed the NiceGUI filter is harmless here');
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);

    await writeFile(promptsFile, '[]');
    await openPicker();
    assert.deepEqual(await itemIds(), []);
    assert.match(await text('[data-testid="oa-prompt-empty"]'), /Aucun prompt disponible/, 'an empty library says so');
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);

    await rm(promptsFile);
    await openPicker();
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'file removed: the defaults are back');

    process.stdout.write(`PASS prompt library: real ✦ click, filter, folder-name fill, "/" without stray slash, Escape / ✕ / backdrop, hot-edited prompts.json (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_PROMPTS_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL prompts visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
