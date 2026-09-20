// Run with Electron, not node. Proves conversation branches end to end through the real UI and the
// REAL worker.mjs: a real mouse hover reveals the ⑂ button, a real click forks, the selector
// shows up, a message sent on the fork lands in the fork (and never in main), switching back
// restores main, the button is absent while a run is in flight, branches survive a reload and are
// per folder, and "Effacer l'historique" makes the selector disappear. Every claim about disk is
// re-read from .openagent/conversations.json — never inferred from what the UI shows.
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-branches-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  const screenshotDir = process.env.OPENAGENT_BRANCHES_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // Fake model: the Nth request answers "réponse N". A request can be held open to keep a run in flight.
    let count = 0;
    let hold = false;
    let onHeld = null;
    const held = [];
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const n = ++count;
        const answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: `réponse ${n}` }, finish_reason: 'stop' }] }));
        };
        if (hold) { held.push({ response, answer }); onHeld?.(); } else answer();
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
    let nextFolder = alpha;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return nextFolder;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'm', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const outgoing = request.op === 'send' ? { ...request, payload: { ...request.payload, connection } } : request;
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
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
    const load = async () => { await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html')); await pause(400); };
    await load();

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const setSelect = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const disk = async folder => JSON.parse(await readFile(join(folder, '.openagent', 'conversations.json'), 'utf8'));
    const branchOf = (doc, id) => doc.branches.find(b => b.id === id);
    const contents = branch => branch.messages.map(m => m.content);
    const forkOf = doc => doc.branches.find(b => b.id !== 'main');
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);

    const send = async message => {
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
    };
    const rectCenter = async selector => js(`(() => {
      const r = document.querySelector(${q(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const openFolder = async name => {
      await click('#oa-open-folder-btn');
      await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].some(e => e.textContent.includes(${JSON.stringify(name)}))`), { what: `folder ${name} listed` });
      await pause(400);
    };

    // ── 1. Two turns on main; no fork yet, so no selector ────────────────────────
    await openFolder('alpha');
    assert.equal(await exists('[data-testid="oa-branch-selector"]'), false, 'no selector while no fork exists');
    await send('premier');
    await waitFor(async () => (await assistantBubbles()).length === 1, { what: 'first reply' });
    await send('second');
    await waitFor(async () => (await assistantBubbles()).length === 2 && await isIdle(), { what: 'second reply' });
    assert.deepEqual(await userBubbles(), ['premier', 'second']);

    // ── 2. The ⑂ button: one per user message, invisible until hovered ───────────
    assert.equal(await countOf('[data-testid="oa-fork-btn"]'), 2, 'one ⑂ per user message, none on AI messages');
    const restingOpacity = await js(`getComputedStyle(document.querySelector('[data-testid="oa-fork-btn"]').parentElement).opacity`);
    assert.equal(restingOpacity, '0', 'the action row is invisible until the message is hovered');
    assert.equal(await js(`document.querySelector('[data-testid="oa-fork-btn"]').title`), 'Créer une branche depuis ici');

    const bubble = await rectCenter('[data-testid="oa-user-bubble"]');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: bubble.x, y: bubble.y });
    await waitFor(async () => (await js(`getComputedStyle(document.querySelector('[data-testid="oa-fork-btn"]').parentElement).opacity`)) === '1', { what: 'hover reveals ⑂' });
    await writeFile(join(screenshotDir, 'branches-1-hover.png'), await capturePng(win));

    // ── 3. A real click on ⑂ forks after the FIRST user message ──────────────────
    const button = await rectCenter('[data-testid="oa-fork-btn"]');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: button.x, y: button.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    await waitFor(() => exists('[data-testid="oa-branch-selector"]'), { what: 'selector appears after the fork' });
    assert.equal(await text('[data-testid="oa-notice"]'), "Branche 'Branche 1' créée.");
    assert.deepEqual(await texts('[data-testid="oa-branch-select"] option'), ['🌿 Main', 'Branche 1']);
    const forkId = forkOf(await disk(alpha)).id;
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').value`), forkId, 'the new branch is the active one');
    assert.deepEqual(await userBubbles(), ['premier'], 'the view is cut right after the clicked message, inclusive');
    assert.deepEqual(await assistantBubbles(), [], 'nothing after the clicked message is copied');
    await writeFile(join(screenshotDir, 'branches-2-forked.png'), await capturePng(win));

    const afterFork = await disk(alpha);
    assert.deepEqual(contents(branchOf(afterFork, 'main')), ['premier', 'réponse 1', 'second', 'réponse 2'], 'main is untouched by forking');
    assert.deepEqual(contents(branchOf(afterFork, forkId)), ['premier']);
    assert.equal(branchOf(afterFork, forkId).label, 'Branche 1');
    const mainBefore = JSON.stringify(branchOf(afterFork, 'main').messages);

    // ── 4. A message sent on the fork lands in the fork, never in main ───────────
    await send('autre piste');
    await waitFor(async () => (await assistantBubbles()).length === 1 && await isIdle(), { what: 'reply on the fork' });
    assert.deepEqual(await assistantBubbles(), ['réponse 3']);
    const afterSend = await disk(alpha);
    assert.deepEqual(contents(branchOf(afterSend, forkId)), ['premier', 'autre piste', 'réponse 3'], 'the fork got the exchange');
    assert.equal(JSON.stringify(branchOf(afterSend, 'main').messages), mainBefore, 'main is byte for byte what it was before');

    // ── 5. Back to main: the full original view, no notice ───────────────────────
    await setSelect('[data-testid="oa-branch-select"]', 'main');
    // Wait for the CONTENT, not the count: the fork view also holds two user messages by now.
    await waitFor(async () => (await userBubbles()).join('|') === 'premier|second', { what: 'main view restored' });
    assert.deepEqual(await userBubbles(), ['premier', 'second']);
    assert.deepEqual(await assistantBubbles(), ['réponse 1', 'réponse 2']);
    assert.equal(await exists('[data-testid="oa-notice"]'), false, 'switching announces nothing');
    await writeFile(join(screenshotDir, 'branches-3-back-on-main.png'), await capturePng(win));

    // Sending after the switch goes to main (the NiceGUI "overwrites chat_history" bug, reversed).
    await send('suite');
    await waitFor(async () => (await assistantBubbles()).length === 3 && await isIdle(), { what: 'reply on main after switching' });
    const afterMain = await disk(alpha);
    assert.deepEqual(contents(branchOf(afterMain, 'main')), ['premier', 'réponse 1', 'second', 'réponse 2', 'suite', 'réponse 4']);
    assert.deepEqual(contents(branchOf(afterMain, forkId)), ['premier', 'autre piste', 'réponse 3'], 'the fork is untouched by a turn on main');

    // ── 6. While a run is in flight: ⑂ absent (not greyed) and the selector locked ─
    hold = true;
    const heldRequest = new Promise(resolve => { onHeld = resolve; });
    await send('en cours');
    await heldRequest;
    await waitFor(async () => !(await isIdle()), { what: 'run in flight' });
    assert.equal(await countOf('[data-testid="oa-fork-btn"]'), 0, 'no ⑂ at all while the agent runs');
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').disabled`), true, 'the selector is locked while the agent runs');
    await writeFile(join(screenshotDir, 'branches-4-running.png'), await capturePng(win));
    hold = false;
    for (const h of held.splice(0)) h.answer();
    await waitFor(async () => (await assistantBubbles()).length === 4 && await isIdle(), { what: 'held run finished' });
    assert.equal(await countOf('[data-testid="oa-fork-btn"]'), 4, '⑂ is back on the 4 user messages once the run ended');
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').disabled`), false);

    // ── 7. Branches live on disk: a fresh page finds them ───────────────────────
    await load();
    await openFolder('alpha');
    await waitFor(() => exists('[data-testid="oa-branch-selector"]'), { what: 'selector after reload' });
    assert.deepEqual(await texts('[data-testid="oa-branch-select"] option'), ['🌿 Main', 'Branche 1']);
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').value`), 'main', 'a folder always opens on main');
    assert.equal((await userBubbles()).length, 4);

    // ── 8. Branches belong to their folder ───────────────────────────────────────
    nextFolder = beta;
    await openFolder('beta');
    await waitFor(async () => !(await exists('[data-testid="oa-branch-selector"]')), { what: 'no stale selector in another folder' });
    assert.deepEqual(await userBubbles(), [], 'the other folder shows its own (empty) conversation');
    await js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes('alpha')).click()`);
    await waitFor(() => exists('[data-testid="oa-branch-selector"]'), { what: 'selector is back on the folder that owns the fork' });

    // ── 9. "Effacer l'historique" drops the forks and hides the selector ─────────
    await click('#oa-settings-btn');
    await pause(300);
    await click('[data-testid="oa-settings-tab"][data-tab="danger"]');
    await pause(200);
    await click('#oa-danger-clear-btn');
    await pause(150);
    await click('#oa-confirm-ok-btn');
    await waitFor(async () => /Historique effacé/.test(await text('[data-testid="oa-danger-status"]')), { what: 'history cleared' });
    await click('#oa-settings-close-btn');
    await pause(300);
    assert.equal(await exists('[data-testid="oa-branch-selector"]'), false, 'the selector is gone after clearing the history');
    assert.deepEqual(await userBubbles(), []);
    const cleared = await disk(alpha);
    assert.equal(cleared.branches.length, 1, 'every fork is gone on disk');
    assert.deepEqual(cleared.branches[0].messages, [], 'main is empty on disk');
    await writeFile(join(screenshotDir, 'branches-5-cleared.png'), await capturePng(win));

    process.stdout.write(`PASS conversation branches: real hover+click fork, isolated sends, switching, persistence, per-folder, cleared (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    if (!process.env.OPENAGENT_BRANCHES_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL branches visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
