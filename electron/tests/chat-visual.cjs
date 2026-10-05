// Run with Electron, not node. Loads the real preload.cjs + built renderer, spawns the
// REAL worker.mjs (not a stub), and relays backend-message like main.cjs does — proves
// a real conversation end to end through the actual UI: open folder → type → send →
// streamed tool-start/message events → a real create_file write → assistant reply
// rendered as markdown, against a fake HTTP provider (same pattern as agent.test.mts).
// Parity rows 6 and 7 (2026-10-05): each tool card shows its name, badge and detail (path, command, query); an
// edit_file shows its diff in colour; a code block is highlighted and the view sits at the bottom; reopening the
// conversation keeps every card; an older conversation saved without names gets them back with a neutral badge; no
// request ever carries a card's name or category. Shift+Enter sends nothing; two quick Enter (the box refilled in
// between), or Enter during a turn, send exactly one request.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
const { Worker } = require('node:worker_threads');
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const callsReply = (...calls) => ({ choices: [{ message: { content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] });
const textReply = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const LONG_REPLY = Array.from({ length: 60 }, (_, i) => `Paragraphe ${i + 1}.`).join('\n\n');
// One answer per request, in order. Request 8 (« tour long ») is held 1.5 s so a message can be typed during it.
const SCRIPT = [
  callsReply(toolCall('call-1', 'create_file', { path: 'notes.md', content: 'salut' })),
  textReply('Fichier **notes.md** créé.'),
  callsReply(toolCall('call-2', 'edit_file', { path: 'notes.md', old_string: 'salut', new_string: 'bonjour' })),
  textReply('Modifié.'),
  callsReply(toolCall('call-3', 'run_command', { command: 'echo ok' }), toolCall('call-4', 'knowledge_search', { query: 'notes' })),
  textReply('Fait :\n\n```python\nprint("ok")\n```\n'),
  textReply('Un seul envoi.'),
  textReply(LONG_REPLY),
];
const HELD_REQUEST = 8;

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-chat-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const other = join(root, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  const screenshotDir = process.env.OPENAGENT_CHAT_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // This test is about the conversation flow; the write and shell prompts (asked by default since 2026-10-03) have
    // their own test, permission-visual.cjs. The user's saved choice is respected.
    const { SettingsService } = await import('../core/settings.mts');
    await new SettingsService(home).saveGlobal({ files_ask: false, shell_ask: false });
    const bodies = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        const index = bodies.length;
        const answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(SCRIPT[Math.min(index, SCRIPT.length) - 1]));
        };
        if (index === HELD_REQUEST) setTimeout(answer, 1500); else answer();
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

    // What the stubbed native folder dialog answers: the project first, another folder to switch away and back.
    let dialogAnswer = project;
    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return dialogAnswer;
      if (request.op === 'global-settings') return { theme: 'dark', accent_color: '#3b82f6', onboarding_done: true };
      if (request.op === 'save-global-settings') return {};
      const payload = request.op === 'send' ? { ...request.payload, connection } : request.payload;
      return callWorker(request.op, payload);
    });

    // Shown at opacity 0 and never focusable, as in export-visual.cjs and prompts-visual.cjs: the real key presses of
    // step 7 (sendInputEvent) reach the focused textarea there without the window ever taking the user's focus.
    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(200);

    const js = code => win.webContents.executeJavaScript(code);
    const typeAndEnter = text => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const sendButton = () => js("document.getElementById('oa-send-btn')?.textContent");
    const idle = () => waitFor(async () => (await sendButton()) === '➤', { what: 'the send button back to idle' });
    const lastBubble = () => js("Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''");
    const cards = () => js(`[...document.querySelectorAll('[data-testid="oa-tool-message"]')].map(card => ({
      name: card.querySelector('[data-testid="oa-tool-name"]')?.textContent ?? null,
      badge: card.querySelector('[data-testid="oa-tool-badge"]')?.dataset.badge ?? null,
      detail: card.querySelector('[data-testid="oa-tool-detail"]')?.textContent ?? null,
    }))`);
    const topBarShows = name => js(`Array.from(document.querySelectorAll('span')).some(el => el.textContent?.startsWith('▸') && el.textContent.includes(${JSON.stringify(name)}))`);
    const openEntry = name => js(`document.querySelector('[data-testid="oa-folder-entry"][data-path$=${JSON.stringify(name)}]').click()`);
    const savedUserTexts = async () => (await callWorker('messages', { folder: project, branchId: 'main' })).filter(m => m.role === 'user').map(m => m.content);
    const inputValue = () => js("document.getElementById('oa-input-ta').value");

    // ── 1. Open the project through the real Sidebar button/dialog flow ──────────
    await js("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(() => js("document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false"), { what: 'project opened' });
    assert.ok(await js("!!document.getElementById('oa-input-ta')"), 'the real InputBar is present once a folder is active');

    // ── 2. create_file: badge, name, detail; markdown; the real file ──────────────
    await typeAndEnter('crée un fichier notes.md');
    const userBubbleShown = await waitFor(() => js("Array.from(document.querySelectorAll('div')).some(el => el.textContent === 'crée un fichier notes.md')"));
    assert.ok(userBubbleShown, 'the user message renders immediately (optimistic, before any agent event)');
    await writeFile(join(screenshotDir, 'chat-1-sending.png'), await capturePng(win));

    await waitFor(() => js("!!document.querySelector('[data-testid=\"oa-tool-message\"]')"));
    const toolBadge = await js("document.querySelector('[data-testid=\"oa-tool-message\"]')?.textContent");
    assert.match(toolBadge, /WRITE/, 'the tool message shows the real WRITE category badge');
    assert.match(toolBadge, /create_file/, 'the tool message names the real tool that ran');
    await writeFile(join(screenshotDir, 'chat-2-tool-ran.png'), await capturePng(win));

    // Two AI bubbles exist by now: the first (empty content) from the tool-call turn,
    // the second with the actual final reply — always check the last one.
    const assistantText = await waitFor(async () => {
      const text = await lastBubble();
      return text.includes('créé') ? text : null;
    });
    assert.match(assistantText, /notes\.md/, 'the assistant reply (rendered markdown) mentions the created file');
    assert.ok(await js("!!Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.querySelector('strong')"),
      'markdown bold (**notes.md**) actually renders as a real <strong> element, not raw asterisks');
    await idle();
    assert.equal(await sendButton(), '➤', 'the send/stop button is back to its idle state once the run is done');
    await writeFile(join(screenshotDir, 'chat-3-done.png'), await capturePng(win));
    assert.equal(await readFile(join(project, 'notes.md'), 'utf8'), 'salut', 'create_file actually wrote the real file on disk, through the real UI click path');
    assert.deepEqual((await cards())[0], { name: 'create_file', badge: 'write', detail: 'notes.md' });
    assert.deepEqual(bodies[1].messages.filter(m => m.role === 'tool').map(m => Object.keys(m).sort()), [['content', 'role', 'tool_call_id']],
      'the request carries no name or category');

    // ── 3. edit_file: its diff, in colour ───────────────────────────────────────
    await typeAndEnter('remplace salut par bonjour');
    await waitFor(async () => (await lastBubble()).includes('Modifié.'), { what: 'the edit turn' });
    await idle();
    assert.equal(await readFile(join(project, 'notes.md'), 'utf8'), 'bonjour');
    assert.deepEqual((await cards())[1], { name: 'edit_file', badge: 'write', detail: 'notes.md' });
    const diffLines = await js(`[...[...document.querySelectorAll('[data-testid="oa-tool-message"]')][1].querySelectorAll('pre')].map(pre => ({ text: pre.textContent, className: pre.className }))`);
    assert.ok(diffLines.some(line => line.text === '-salut' && line.className.includes('text-red-400')), JSON.stringify(diffLines));
    assert.ok(diffLines.some(line => line.text === '+bonjour' && line.className.includes('text-green-400')), JSON.stringify(diffLines));
    await writeFile(join(screenshotDir, 'chat-4-diff.png'), await capturePng(win));

    // ── 4. run_command and a search: their detail; a code block is highlighted ───
    await typeAndEnter('lance echo puis cherche');
    await waitFor(async () => (await lastBubble()).includes('Fait'), { what: 'the command and search turn' });
    await idle();
    const live = await cards();
    assert.deepEqual(live.slice(2), [
      { name: 'run_command', badge: 'shell', detail: 'echo ok' },
      { name: 'knowledge_search', badge: 'read', detail: 'notes' },
    ]);
    assert.ok(await js("!!Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.querySelector('pre code.hljs')"),
      'a ```python block is rendered highlighted');

    // ── 5. Reopening the conversation keeps every card ──────────────────────────
    // Another folder first: clicking the active folder's own entry does not reload the chat (ChatProvider is keyed on it).
    dialogAnswer = other;
    await js("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(async () => (await topBarShows('other')) && (await cards()).length === 0, { what: 'the other folder active' });
    await openEntry('project');
    await waitFor(async () => (await cards()).length === 4, { what: 'the reopened conversation' });
    assert.deepEqual(await cards(), live, 'name, badge and detail are all back after reopening');
    await writeFile(join(screenshotDir, 'chat-5-reopened.png'), await capturePng(win));

    // ── 6. A conversation saved before 2026-10-05: names recovered, neutral badge ─
    await callWorker('save-messages', {
      folder: project, branchId: 'main', messages: [
        { role: 'user', content: 'lis le vieux fichier' },
        { role: 'assistant', content: '', tool_calls: [toolCall('old-1', 'read_file', { path: 'legacy.txt' })] },
        { role: 'tool', tool_call_id: 'old-1', content: 'contenu ancien' },
        { role: 'assistant', content: 'Lu.' },
      ],
    });
    await openEntry('other');
    await waitFor(async () => (await topBarShows('other')) && (await cards()).length === 0, { what: 'the other folder again' });
    await openEntry('project');
    await waitFor(async () => (await lastBubble()).includes('Lu.'), { what: 'the older conversation shown' });
    assert.deepEqual(await cards(), [{ name: 'read_file', badge: 'neutral', detail: 'legacy.txt' }]);
    await writeFile(join(screenshotDir, 'chat-6-legacy.png'), await capturePng(win));

    // ── 7. Row 7: Shift+Enter inserts a new line and sends nothing ───────────────
    // A REAL key press (sendInputEvent: keyDown, char, keyUp through Chromium's own keyboard pipeline), not a synthetic
    // KeyboardEvent, which never performs the browser's default action: the new line in the box proves the textarea got
    // Shift+Enter, the fake server proves nothing was sent.
    const beforeShift = bodies.length;
    await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'ligne 1');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    })()`);
    assert.equal(await js('document.activeElement?.id'), 'oa-input-ta', 'the box has the focus before the key press');
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Enter', modifiers: ['shift'] });
    await waitFor(async () => (await inputValue()).includes('\n'), { timeout: 3000, what: 'the new line from Shift+Enter' });
    assert.equal(await inputValue(), 'ligne 1\n', 'Shift+Enter put a new line in the box');
    await pause(500);
    assert.equal(bodies.length, beforeShift, 'no request for Shift+Enter');

    // ── 8. Two quick Enter, the box refilled in between: one request ─────────────
    const cancelled = await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      const set = text => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const enter = () => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      set('premier envoi');
      const first = enter();
      const second = enter();
      set('second envoi');
      const third = enter();
      return [first, second, third];
    })()`);
    assert.deepEqual(cancelled, [true, true, true], 'a plain Enter is always taken by the app, never a new line');
    await waitFor(async () => (await lastBubble()).includes('Un seul envoi.'), { what: 'the one turn' });
    await idle();
    await pause(500);
    assert.equal(bodies.length, beforeShift + 1, 'exactly one request for the quick double Enter');
    assert.equal(await inputValue(), 'second envoi', 'what was typed during the send stays in the box');
    const afterDouble = await savedUserTexts();
    assert.equal(afterDouble.filter(text => text === 'premier envoi').length, 1);
    assert.equal(afterDouble.includes('second envoi'), false);

    // ── 9. Enter during a turn: no request ──────────────────────────────────────
    await typeAndEnter('tour long');
    await waitFor(async () => (await sendButton()) === '■', { what: 'the turn running' });
    await waitFor(() => bodies.length === HELD_REQUEST, { what: 'the held request reached the model' });
    await typeAndEnter('pendant le tour');
    await pause(300);
    assert.equal(bodies.length, HELD_REQUEST, 'Enter during a turn sends nothing');
    await waitFor(async () => (await lastBubble()).includes('Paragraphe 60.'), { timeout: 10000, what: 'the long turn' });
    await idle();
    await pause(300);
    assert.equal(bodies.length, HELD_REQUEST, 'still one request for that turn');
    assert.equal(await inputValue(), 'pendant le tour', 'the refused text stays in the box');
    const afterLong = await savedUserTexts();
    assert.equal(afterLong.includes('pendant le tour'), false);
    assert.equal(afterLong.filter(text => text === 'tour long').length, 1);

    // ── 10. The view sits at the bottom of a conversation taller than the window ──
    await waitFor(async () => {
      const view = await js(`(() => {
        const el = document.querySelector('[data-testid="oa-chat-scroll"]');
        return { overflow: el.scrollHeight > el.clientHeight, gap: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) };
      })()`);
      return view.overflow && view.gap <= 2;
    }, { what: 'the view at the bottom of a long conversation' });
    await writeFile(join(screenshotDir, 'chat-7-long.png'), await capturePng(win));

    process.stdout.write(`PASS real conversation through the UI creates a file and renders markdown; tool cards (name, badge, detail, diff) survive a reopen; Shift+Enter and the double send proven (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (!process.env.OPENAGENT_CHAT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL chat visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
