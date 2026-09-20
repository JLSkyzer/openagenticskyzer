// Run with Electron, not node. Proves the context gauge and the compaction end to end through the
// real UI and the REAL worker.mjs (fake model over HTTP): the numbers shown are recomputed from the
// conversation file on disk, the colours follow the levels, the real settings dialog changes the gauge
// live, a real click on "⚡ Auto-compact" summarises the conversation (input locked meanwhile), a
// failing model leaves the history exactly as it was, the automatic compaction fires after a turn
// only when switched on, and the gauge follows the branch on screen.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
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

// max_tokens 4096 minus the default 2048 reserved tokens: a limit of exactly 2048 tokens.
const LIMIT = 4096 - 2048;

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-context-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  // Both folders are already in the sidebar: the test moves between them with real clicks.
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: alpha, last_used: new Date().toISOString() },
    { path: beta, last_used: new Date(Date.now() - 1000).toISOString() },
  ]));
  const screenshotDir = process.env.OPENAGENT_CONTEXT_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // Fake model. A summary request is the one with no tool and a single "Résume cette conversation" message.
    const requests = [];
    const held = [];
    const state = { summary: 'ok', normalCount: 0 };
    let onHeld = null;
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw);
        const isSummary = !body.tools && body.messages.length === 1 && String(body.messages[0].content).startsWith('Résume cette conversation');
        requests.push({ body, isSummary });
        const answer = () => {
          if (isSummary && state.summary === 'fail') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"boom"}'); return; }
          const content = isSummary ? '- décision : garder la branche A\n- fichier modifié : notes.md' : `réponse ${++state.normalCount}`;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
        };
        if (isSummary && state.summary === 'hold') { held.push(answer); onHeld?.(); } else answer();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
    const summaryRequests = () => requests.filter(r => r.isSummary).length;

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
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'connection-snapshot') {
        return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      // Same routing as main.cjs: the operations that call the model receive the resolved connection.
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
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const attr = (selector, name) => js(`document.querySelector(${q(selector)})?.getAttribute(${JSON.stringify(name)})`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const setSelect = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8'));
    const mainOnDisk = async () => (await disk()).branches.find(b => b.id === 'main').messages;
    const send = async message => {
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
    };

    // What the gauge must say, computed here from the messages ON DISK (4 characters per token, user +
    // assistant only, limit 2048): the test never trusts the number the UI shows about itself.
    const expected = messages => {
      const chars = messages.filter(m => m.role === 'user' || m.role === 'assistant').reduce((sum, m) => sum + [...m.content].length, 0);
      const tokens = Math.floor(chars / 4);
      const pct = Math.min(100, (tokens / LIMIT) * 100);
      return { tokens, pct, label: `${Math.round(pct)}% · ~${tokens.toLocaleString('en-US')} tokens`, level: pct < 70 ? 'normal' : pct < 90 ? 'warning' : 'critical' };
    };
    // A history of `count` messages of `length` characters, alternating user / assistant, each starting with a tag.
    const history = (count, length) => Array.from({ length: count }, (_, i) => {
      const tag = i % 2 === 0 ? `q${i / 2 + 1}-` : `r${(i - 1) / 2 + 1}-`;
      return { role: i % 2 === 0 ? 'user' : 'assistant', content: tag + 'x'.repeat(length - tag.length) };
    });
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)})).click()`);
    // Puts a history on disk, then reloads the folder in the page (hop to the other folder and back: the
    // chat only re-reads the saved history when the active folder changes).
    const reloadWith = async messages => {
      await callWorker('save-messages', { folder: alpha, branchId: 'main', messages });
      await enter('beta');
      await pause(400);
      await enter('alpha');
      await waitFor(() => exists('#oa-input-ta'), { what: 'alpha reloaded' });
      await pause(500);
    };
    const gauge = async () => ({ label: await text('[data-testid="oa-context-label"]'), level: await attr('[data-testid="oa-context-fill"]', 'data-level'), width: await attr('[data-testid="oa-context-fill"]', 'style') });
    // The real settings dialog: open, go to Contexte, set what differs, Enregistrer, close.
    const setContextSettings = async ({ threshold, auto, show }) => {
      await click('#oa-settings-btn');
      await waitFor(() => exists('[data-testid="oa-settings-tab"][data-tab="context"]'), { what: 'settings dialog' });
      await click('[data-testid="oa-settings-tab"][data-tab="context"]');
      await pause(200);
      if (threshold !== undefined) await setValue('[data-setting="compact_threshold"]', threshold);
      const toggle = async (name, want) => { if (want !== undefined && (await js(`document.querySelector('[data-setting="${name}"]').checked`)) !== want) await click(`[data-setting="${name}"]`); };
      await toggle('auto_compact', auto);
      await toggle('show_context_bar', show);
      await click('#oa-settings-save-btn');
      await waitFor(async () => /Paramètres sauvegardés/.test(await text('[data-testid="oa-settings-status"]')), { what: 'settings saved' });
      await click('#oa-settings-close-btn');
      await pause(400);
    };

    await callWorker('save-global-settings', { patch: { max_tokens: 4096, auto_compact: false, compact_threshold: 70 } });
    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`), { what: 'both folders in the sidebar' });

    // ── 1. The numbers on screen are the ones of the file on disk ────────────────
    await reloadWith(history(6, 800));
    let want = expected(await mainOnDisk());
    assert.equal(want.label, '59% · ~1,200 tokens', 'sanity check of the fixture itself');
    assert.equal(await exists('[data-testid="oa-context-bar"]'), true, 'the gauge is shown');
    assert.match(await text('[data-testid="oa-context-bar"]'), /🧠 Contexte/);
    let shown = await gauge();
    assert.equal(shown.label, want.label, 'label recomputed from conversations.json');
    assert.equal(shown.level, 'normal');
    assert.match(shown.width, /width:\s*59%/);
    assert.equal(await exists('#oa-compact-btn'), false, 'under the threshold there is no compaction button');
    await writeFile(join(screenshotDir, 'context-1-normal.png'), await capturePng(win));

    // ── 2. Colours and the cap, still checked against the disk ───────────────────
    for (const [count, length, level, screenshot] of [[8, 800, 'warning', null], [8, 950, 'critical', 'context-2-critical.png'], [8, 2000, 'critical', null]]) {
      await reloadWith(history(count, length));
      want = expected(await mainOnDisk());
      shown = await gauge();
      assert.equal(shown.label, want.label, `label for ${count}×${length}`);
      assert.equal(shown.level, level, `level for ${want.label}`);
      assert.equal(want.level, level);
      if (screenshot) await writeFile(join(screenshotDir, screenshot), await capturePng(win));
    }
    assert.equal(shown.label, '100% · ~4,000 tokens', 'past the limit the percentage stops at 100, the token count does not');
    assert.match(shown.width, /width:\s*100%/);
    assert.equal(await exists('#oa-compact-btn'), true, 'the button shows once the threshold is reached');

    // ── 3. The settings dialog changes the gauge live ────────────────────────────
    await reloadWith(history(6, 800));
    assert.equal(await exists('#oa-compact-btn'), false, '59% is under the threshold of 70');
    await setContextSettings({ threshold: 50 });
    assert.equal(await exists('#oa-compact-btn'), true, 'lowering the threshold to 50 shows the button at once, no restart');
    await writeFile(join(screenshotDir, 'context-3-button.png'), await capturePng(win));
    await setContextSettings({ show: false });
    assert.equal(await exists('[data-testid="oa-context-bar"]'), false, 'switching the gauge off in the settings hides it');
    await setContextSettings({ show: true });
    assert.equal(await exists('[data-testid="oa-context-bar"]'), true, 'and back on');

    // ── 4. Automatic compaction off: a turn above the threshold summarises nothing ──
    const repliesBefore = (await assistantBubbles()).length;
    await send('petit message');
    await waitFor(async () => (await assistantBubbles()).length === repliesBefore + 1 && await isIdle(), { what: 'reply' });
    await pause(600);
    assert.equal(summaryRequests(), 0, 'auto_compact is off: no summary was requested');

    // ── 5. A real click compacts: locked while it runs, then summary + last exchange on disk ──
    await reloadWith(history(6, 800));
    const before = await mainOnDisk();
    state.summary = 'hold';
    const heldRequest = new Promise(resolve => { onHeld = resolve; });
    await click('#oa-compact-btn');
    await heldRequest;
    await waitFor(() => exists('[data-testid="oa-context-compacting"]'), { what: '"Compression en cours…"' });
    assert.equal(await js(`document.getElementById('oa-compact-btn').disabled`), true, 'the button is disabled while compacting');
    await send('pendant la compression');
    await pause(400);
    assert.equal(await js(`document.getElementById('oa-input-ta').value`), 'pendant la compression', 'the typed text is kept, not lost');
    assert.equal((await userBubbles()).includes('pendant la compression'), false, 'nothing was sent during the compaction');
    assert.equal(await exists('[data-testid="oa-fork-btn"]'), false, 'no ⑂ while the conversation is being rewritten');
    await writeFile(join(screenshotDir, 'context-4-compacting.png'), await capturePng(win));
    state.summary = 'ok';
    for (const answer of held.splice(0)) answer();
    await waitFor(() => exists('[data-testid="oa-notice"]'), { what: 'compaction notice' });
    assert.equal(await text('[data-testid="oa-notice"]'), 'Contexte compressé avec résumé IA.');
    const after = await mainOnDisk();
    assert.equal(after.length, 3, 'summary + the last user message + its reply');
    assert.match(after[0].content, /^\*\*\[Résumé de contexte compressé\]\*\*\n\n- décision : garder la branche A/);
    assert.deepEqual(after.slice(1), before.slice(-2), 'the last exchange is kept untouched');
    assert.deepEqual(await userBubbles(), [before.at(-2).content], 'the screen shows the same thing as the disk');
    assert.match((await assistantBubbles())[0], /Résumé de contexte compressé/);
    assert.equal(await exists('[data-testid="oa-context-compacting"]'), false);
    assert.equal((await gauge()).label, expected(after).label, 'the gauge dropped, and matches the new file');
    const summaryRequest = requests.find(r => r.isSummary).body;
    assert.equal(summaryRequest.tools, undefined, 'the summariser was given no tool');
    assert.equal(summaryRequest.messages.length, 1);
    const found = [...await readdir(home, { recursive: true }), ...await readdir(join(alpha, '.openagent'), { recursive: true })];
    assert.equal(found.some(name => String(name).endsWith('memory.md')), false, `the summary was not written into memory.md: ${JSON.stringify(found)}`);
    await writeFile(join(screenshotDir, 'context-5-compacted.png'), await capturePng(win));

    // ── 6. A failing model leaves everything as it was ───────────────────────────
    await reloadWith(history(6, 800));
    const untouched = JSON.stringify(await mainOnDisk());
    state.summary = 'fail';
    const requestsBefore = summaryRequests();
    await click('#oa-compact-btn');
    await waitFor(() => exists('[data-testid="oa-chat-error"]'), { what: 'error shown' });
    assert.match(await text('[data-testid="oa-chat-error"]'), /Erreur du provider \(500\)/);
    // The text being in the DOM is not enough: a banner left below the fold is an error nobody sees.
    await pause(300);
    assert.equal(await js(`(() => {
      const banner = document.querySelector('[data-testid="oa-chat-error"]').getBoundingClientRect();
      const view = document.querySelector('[data-testid="oa-chat-scroll"]').getBoundingClientRect();
      return banner.top >= view.top && banner.bottom <= view.bottom;
    })()`), true, 'the error is scrolled into view');
    assert.equal(summaryRequests(), requestsBefore + 1, 'the model was really asked');
    assert.equal(JSON.stringify(await mainOnDisk()), untouched, 'not one message was dropped on disk');
    assert.equal((await userBubbles()).length, 3, 'nor on screen');
    assert.equal(await exists('[data-testid="oa-context-compacting"]'), false);
    assert.equal(await js(`document.getElementById('oa-compact-btn').disabled`), false, 'the button can be used again');
    await writeFile(join(screenshotDir, 'context-6-error.png'), await capturePng(win));
    state.summary = 'ok';

    // ── 7. Automatic compaction on: one attempt after a completed turn, no click ─
    await setContextSettings({ auto: true });
    await reloadWith(history(6, 800));
    const summariesBefore = summaryRequests();
    await send('suite');
    await waitFor(async () => (await mainOnDisk())[0]?.content.startsWith('**[Résumé de contexte compressé]**'), { timeout: 15000, what: 'automatic compaction' });
    assert.equal(summaryRequests(), summariesBefore + 1, 'exactly one summary for the turn');
    const auto = await mainOnDisk();
    assert.equal(auto.at(-2).content, 'suite', 'the message that triggered it is kept, with its reply');
    assert.equal(auto.length, 3);
    await waitFor(() => exists('[data-testid="oa-notice"]'), { what: 'notice after auto compaction' });

    // ── 8. The gauge follows the branch on screen ────────────────────────────────
    await setContextSettings({ auto: false });
    await callWorker('save-messages', { folder: alpha, branchId: 'main', messages: history(6, 800) });
    const fork = await callWorker('fork', { folder: alpha, source: 'main', count: 2, label: 'Branche 1' });
    await reloadWith(history(6, 800));
    await waitFor(() => exists('[data-testid="oa-branch-select"]'), { what: 'branch selector' });
    assert.equal((await gauge()).label, '59% · ~1,200 tokens');
    await setSelect('[data-testid="oa-branch-select"]', fork.id);
    await waitFor(async () => (await gauge()).label === '20% · ~400 tokens', { what: 'gauge follows the branch' });
    assert.equal((await gauge()).label, expected((await disk()).branches.find(b => b.id === fork.id).messages).label);
    await setSelect('[data-testid="oa-branch-select"]', 'main');
    await waitFor(async () => (await gauge()).label === '59% · ~1,200 tokens', { what: 'gauge back on main' });

    process.stdout.write(`PASS context gauge: numbers match the disk, live settings, real-click compaction, failure-safe, auto-compact, per-branch (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
    if (!process.env.OPENAGENT_CONTEXT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL context visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
