// Run with Electron, not node. Proves ✏️ edit and 🔄 regenerate end to end through the real UI and the REAL
// worker.mjs, with a fake HTTP model that records what it is sent: real turns build the conversation, a real
// click on 🔄 drops the last reply and asks again (the model never sees the dropped reply), a real mouse hover
// + click on ✏️ puts the message back in the box and cuts the view WITHOUT touching the disk (abandoning the
// edit loses nothing — proved by reloading the folder), sending the edited text replaces the saved tail, editing
// the first message starts over, both buttons are absent while a run is in flight, and a view that no longer
// matches what is saved is refused and reloaded. Every claim about disk is re-read from conversations.json.
// Nothing here opens an external application.
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-edit-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  const screenshotDir = process.env.OPENAGENT_EDIT_SCREENSHOT_DIR || home;
  // Declared before the try: the catch below reads them (a const inside `try {}` is invisible there).
  const pageMessages = [];
  let win;
  let server;
  let worker;
  try {
    // Fake model: the Nth request answers "réponse N" and is recorded. A request can be held to keep a run in flight.
    let count = 0;
    let hold = false;
    let onHeld = null;
    const held = [];
    const modelRequests = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const n = ++count;
        modelRequests.push(JSON.parse(raw));
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
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
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
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', event => pageMessages.push(`[${event.level}] ${event.message}`));
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const boxValue = () => js(`document.getElementById('oa-input-ta').value`);
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).branches.find(b => b.id === 'main').messages.map(m => m.content);
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const sentToModel = index => JSON.stringify(modelRequests[index].messages.map(m => m.content));
    const send = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const rectCenter = selector => js(`(() => {
      const list = document.querySelectorAll(${q(selector)});
      const r = list[list.length - 1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const mouseClickAt = ({ x, y }) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    const openFolder = async (name = 'alpha') => {
      nextFolder = name === 'alpha' ? alpha : beta;
      await click('#oa-open-folder-btn');
      await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].some(e => e.textContent.includes(${JSON.stringify(name)}))`), { what: `folder ${name} listed` });
      await pause(400);
    };

    // ── 1. A real conversation: two turns ───────────────────────────────────────
    await openFolder();
    await send('premier');
    await waitFor(async () => (await assistantBubbles()).length === 1 && await isIdle(), { what: 'first reply' });
    await send('second');
    await waitFor(async () => (await assistantBubbles()).length === 2 && await isIdle(), { what: 'second reply' });
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 2']);

    // ── 2. ✏️ on every user message, 🔄 only under the last reply ────────────────
    assert.equal(await countOf('[data-testid="oa-edit-btn"]'), 2, 'one ✏️ per user message');
    assert.equal(await countOf('[data-testid="oa-regenerate-btn"]'), 1, 'one 🔄, under the last reply only');
    assert.match(await js(`document.querySelector('[data-testid="oa-regenerate-btn"]').previousElementSibling.textContent`), /réponse 2/, '🔄 sits under the LAST reply');
    assert.equal(await js(`document.querySelector('[data-testid="oa-edit-btn"]').title`), 'Éditer ce message');
    assert.equal(await js(`document.querySelector('[data-testid="oa-regenerate-btn"]').title`), 'Régénérer cette réponse');

    // ── 3. 🔄: the last reply is dropped and asked again; the buttons are absent while it runs ─────────────────
    hold = true;
    const heldRequest = new Promise(resolve => { onHeld = resolve; });
    await click('[data-testid="oa-regenerate-btn"]');
    await heldRequest;
    await waitFor(async () => !(await isIdle()), { what: 'run in flight' });
    assert.equal(await countOf('[data-testid="oa-edit-btn"]'), 0, '✏️ is absent (not greyed) while a run is in flight');
    assert.equal(await countOf('[data-testid="oa-regenerate-btn"]'), 0, '🔄 is absent while a run is in flight');
    assert.deepEqual(await userBubbles(), ['premier', 'second']);
    assert.deepEqual(await assistantBubbles(), ['réponse 1'], 'the dropped reply is gone from the view');
    hold = false;
    for (const item of held.splice(0)) item.answer();
    await waitFor(async () => (await assistantBubbles()).length === 2 && await isIdle(), { what: 'regenerated reply' });
    assert.equal(sentToModel(2).includes('réponse 2'), false, 'the model was not shown the reply being replaced');
    assert.ok(sentToModel(2).includes('second') && sentToModel(2).includes('réponse 1') && sentToModel(2).includes('premier'));
    assert.deepEqual(await assistantBubbles(), ['réponse 1', 'réponse 3']);
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 3'], 'on disk the old reply is replaced, nothing else moved');
    await writeFile(join(screenshotDir, 'edit-1-regenerated.png'), await capturePng(win));

    // ── 4. ✏️ with a REAL hover and a REAL click: the text goes back into the box, the view is cut,
    //      the disk is NOT touched ───────────────────────────────────────────────────────────────────────
    // The machine's real cursor can steal :hover from a single synthetic move: send it again until the button shows.
    await waitFor(async () => {
      const bubble = await rectCenter('[data-testid="oa-user-bubble"]');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: bubble.x, y: bubble.y });
      await pause(200);
      return (await js(`(() => { const b = document.querySelectorAll('[data-testid="oa-edit-btn"]'); return getComputedStyle(b[b.length - 1].parentElement).opacity === '1'; })()`));
    }, { timeout: 10000, interval: 100, what: 'hover reveals ✏️' });
    mouseClickAt(await rectCenter('[data-testid="oa-edit-btn"]'));
    await waitFor(async () => (await boxValue()) === 'second', { what: 'the message is back in the box' });
    assert.equal(await js(`document.activeElement?.id`), 'oa-input-ta', 'the box has the focus');
    assert.deepEqual(await userBubbles(), ['premier'], 'the view is cut before the edited message');
    assert.deepEqual(await assistantBubbles(), ['réponse 1']);
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 3'], 'nothing is cut on disk until something is sent');
    await writeFile(join(screenshotDir, 'edit-2-editing.png'), await capturePng(win));

    // ── 5. Abandoning the edit loses nothing: leaving the folder and coming back shows everything again
    //      (the view stays cut until the folder is reloaded, like the NiceGUI app's in-memory cut) ──────────
    await openFolder('beta');
    await waitFor(async () => (await userBubbles()).length === 0, { what: 'beta is empty' });
    await openFolder('alpha');
    await waitFor(async () => (await userBubbles()).length === 2, { what: 'the full conversation is back' });
    assert.deepEqual(await assistantBubbles(), ['réponse 1', 'réponse 3']);

    // ── 6. ✏️ then send the edited text: the saved tail is replaced ────────────────────────────────────────
    // The box still holds the text of the abandoned edit (leaving a folder does not empty it): empty it, and wait
    // for the CUT (not just the text) before typing — otherwise the send can outrun the edit.
    await js(`(() => { const el = document.getElementById('oa-input-ta'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await js(`document.querySelectorAll('[data-testid="oa-edit-btn"]')[1].click()`);
    await waitFor(async () => (await boxValue()) === 'second' && (await userBubbles()).length === 1, { what: 'second is back in the box and the view is cut' });
    await send('second (édité)');
    await waitFor(async () => (await assistantBubbles()).length === 2 && await isIdle(), { what: 'reply to the edited message' });
    assert.equal(sentToModel(3).includes('réponse 3'), false, 'the cut tail was not sent');
    assert.equal(sentToModel(3).includes('"second"'), false, 'the old wording was not sent');
    assert.ok(sentToModel(3).includes('second (édité)'));
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second (édité)', 'réponse 4']);
    assert.deepEqual(await userBubbles(), ['premier', 'second (édité)']);

    // ── 7. Editing the very FIRST message starts the conversation over ─────────────────────────────────────
    await js(`document.querySelectorAll('[data-testid="oa-edit-btn"]')[0].click()`);
    await waitFor(async () => (await boxValue()) === 'premier' && (await userBubbles()).length === 0, { what: 'premier is back in the box and the view is empty' });
    await send('autre début');
    await waitFor(async () => (await assistantBubbles()).length === 1 && await isIdle(), { what: 'reply after starting over' });
    assert.equal(sentToModel(4).includes('réponse 1'), false);
    assert.deepEqual(await disk(), ['autre début', 'réponse 5']);

    // ── 8. A view that no longer matches what is saved is refused, and the saved one is shown ─────────────────
    await callWorker('save-messages', { folder: alpha, branchId: 'main', messages: [{ role: 'user', content: 'ailleurs' }, { role: 'assistant', content: 'modifié ailleurs' }] });
    await js(`document.querySelectorAll('[data-testid="oa-edit-btn"]')[0].click()`);
    await waitFor(() => exists('[data-testid="oa-chat-error"]'), { what: 'mismatch reported' });
    assert.match(await js(`document.querySelector('[data-testid="oa-chat-error"]').textContent`), /ne correspondait plus/);
    assert.deepEqual(await userBubbles(), ['ailleurs'], 'the saved conversation is what is shown now');
    assert.equal(await boxValue(), '', 'nothing was put in the box');
    assert.deepEqual(await disk(), ['ailleurs', 'modifié ailleurs'], 'the saved conversation was not touched');
    await writeFile(join(screenshotDir, 'edit-3-mismatch.png'), await capturePng(win));

    process.stdout.write(`PASS edit + regenerate: real click 🔄 (dropped reply never sent), real hover+click ✏️ (disk untouched until send, abandon loses nothing), edited send replaces the tail, first message starts over, buttons absent while running, stale view refused (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'edit-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-10))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    server?.closeAllConnections?.();
    server?.close();
    if (!process.env.OPENAGENT_EDIT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL edit-regenerate visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
