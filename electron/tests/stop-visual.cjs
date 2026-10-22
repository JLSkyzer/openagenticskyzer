// Run with Electron, not node. Proves Stop mid-stream through the real UI: a slow SSE
// provider that never finishes on its own, interrupted by clicking the real send/stop
// button — the stream must actually stop (no more text arrives), the partial reply must
// still render as a normal message (not lost), and it must be the exact text persisted
// to disk, not just React state that would vanish on reload.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
const { Worker } = require('node:worker_threads');
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-stop-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_STOP_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // 28 chunks, one every 250 ms: « interrompue. » comes 7 s after the start, well after the click (about 3 s in, once
    // the status line's timer has been read twice, 2.2 s apart) — the stop proof needs a stream still running (B1).
    const chunks = ['Voici ', 'une ', 'réponse ', 'assez ', 'longue ', ...Array.from({ length: 20 }, () => 'encore '), 'pour ', 'être ', 'interrompue.'];
    let clientClosed = false;
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) { clearInterval(timer); return; } // never finishes on its own
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\r\n\r\n`);
        i++;
      }, 250);
      request.on('close', () => { clientClosed = true; clearInterval(timer); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const testModel = { base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', contextWindow: 16384 };

    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home }, workerData: { testProviderModule: path.join(__dirname, 'support', 'test-model-provider.mts') } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'global-settings') return { theme: 'dark', accent_color: '#3b82f6', onboarding_done: true };
      if (request.op === 'save-global-settings') return {};
      let outgoing = request;
      if (request.op === 'send') outgoing = { ...request, payload: { ...request.payload, testModel } };
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
      });
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));

    await win.webContents.executeJavaScript("document.getElementById('oa-open-folder-btn').click()");
    // The input bar always exists in the DOM (even with no active folder) — waiting on
    // it alone races the async folder activation. Wait for the real signal instead: the
    // sidebar entry appearing means activate_folder actually resolved.
    await waitFor(() => win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false",
    ));

    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'bonjour, raconte une longue histoire');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);

    // Wait until the button flips to Stop and at least two chunks have streamed in.
    await waitFor(() => win.webContents.executeJavaScript("document.getElementById('oa-send-btn')?.textContent === '■'"));
    await waitFor(async () => {
      const text = await win.webContents.executeJavaScript("document.body.textContent");
      return text.includes('Voici ') && text.includes('une ');
    });

    // The status line: absent before the first delta (no run, then « Préparation » / « Lecture »), « writing » once text
    // streams. It must be SEEN, inside the scrolling chat, not just in the DOM (lesson 2026-09-21).
    await waitFor(() => win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-turn-status\"][data-phase=\"writing\"]') !== null",
    ));
    const placement = await win.webContents.executeJavaScript(`
      (() => {
        const line = document.querySelector('[data-testid="oa-turn-status"]').getBoundingClientRect();
        const view = document.querySelector('[data-testid="oa-chat-scroll"]').getBoundingClientRect();
        return { line: [line.top, line.bottom, line.left, line.right], view: [view.top, view.bottom, view.left, view.right] };
      })()
    `);
    assert.ok(
      placement.line[0] >= placement.view[0] && placement.line[1] <= placement.view[1] && placement.line[2] >= placement.view[2] && placement.line[3] <= placement.view[3],
      `the status line lies inside the visible chat: ${JSON.stringify(placement)}`,
    );
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-testid=\"oa-turn-label\"]').textContent"), 'Écriture…');
    // The timer runs: two reads 2.2 s apart differ (it ticks every second, in whole seconds).
    const readTimer = () => win.webContents.executeJavaScript("document.querySelector('[data-testid=\"oa-turn-timer\"]')?.textContent ?? null");
    const timerFirst = await readTimer();
    await new Promise(resolve => setTimeout(resolve, 2200));
    const timerSecond = await readTimer();
    assert.match(timerFirst ?? '', /^\d+ s$/, `the timer shows whole seconds: ${timerFirst}`);
    assert.notEqual(timerSecond, timerFirst, `the timer moved in 2.2 s: ${timerFirst} → ${timerSecond}`);

    const shotStreaming = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'stop-1-streaming.png'), shotStreaming.toPNG());

    // Records whether, at any moment from here, the button was disabled and the line said « Arrêt en cours… »: the
    // stop may be too fast for a poll to see it.
    await win.webContents.executeJavaScript(`
      (() => {
        const seen = window.__oaStopSeen = { disabled: false, stopping: false };
        const check = () => {
          if (document.getElementById('oa-send-btn')?.disabled) seen.disabled = true;
          if (document.querySelector('[data-testid="oa-turn-label"]')?.textContent === 'Arrêt en cours…') seen.stopping = true;
        };
        check();
        new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      })();
    `);
    assert.deepEqual(await win.webContents.executeJavaScript('window.__oaStopSeen'), { disabled: false, stopping: false }, 'nothing is stopping before the click');

    const textAtClick = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''",
    );
    assert.ok(textAtClick.includes('Voici'), 'some partial text streamed in before Stop was clicked');
    assert.ok(!textAtClick.includes('interrompue'), 'the stream had not finished yet — Stop is actually testing something');

    // Click Stop.
    await win.webContents.executeJavaScript("document.getElementById('oa-send-btn').click()");
    // One capture while stopping, when the stop has not ended yet.
    if (await win.webContents.executeJavaScript("document.getElementById('oa-send-btn')?.disabled === true")) {
      const shotStopping = await win.webContents.capturePage();
      await writeFile(join(screenshotDir, 'stop-1b-stopping.png'), shotStopping.toPNG());
    } else {
      process.stdout.write('note: the stop ended before a capture of « Arrêt en cours… » could be taken\n');
    }
    await waitFor(() => win.webContents.executeJavaScript("document.getElementById('oa-send-btn')?.textContent === '➤'"));
    const seen = await win.webContents.executeJavaScript('window.__oaStopSeen');
    assert.equal(seen.disabled, true, 'the button was disabled between the click and the end of the turn');
    assert.equal(seen.stopping, true, 'the line said « Arrêt en cours… » between the click and the end of the turn');
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('oa-send-btn').disabled"), false, 'the button is enabled again once stopped');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-testid=\"oa-turn-status\"]') === null"), true, 'the status line is gone once stopped');

    const textAfterStop = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''",
    );
    assert.ok(textAfterStop.length > 0, 'the partial reply is still shown as a real message after Stop, not discarded');
    assert.ok(!textAfterStop.includes('interrompue'), 'the reply is genuinely partial — the stream never reached its final chunk');

    // The stream must actually be stopped: wait past another chunk interval and confirm
    // nothing new arrived (not just that the UI stopped listening).
    await new Promise(resolve => setTimeout(resolve, 600));
    const textStable = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''",
    );
    assert.equal(textStable, textAfterStop, 'no further text arrived after Stop — the underlying HTTP stream was really aborted');
    assert.ok(clientClosed, 'the server actually observed the client closing the connection (real abort, not just a UI-side ignore)');

    const shotStopped = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'stop-2-stopped.png'), shotStopped.toPNG());

    // Persistence: what's on screen must be exactly what a fresh read from disk sees —
    // not React state that would vanish on reload.
    const persistId = `persist-${Date.now()}`;
    const persisted = await new Promise((resolve, reject) => {
      pending.set(persistId, { resolve, reject });
      worker.postMessage({ id: persistId, op: 'messages', payload: { folder: project, branchId: 'main' } });
    });
    assert.equal(persisted.length, 2, 'exactly the user message and the partial assistant reply were saved');
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[1].role, 'assistant');
    // Markdown rendering trims trailing whitespace in a paragraph (normal, expected) —
    // compare trimmed on both sides rather than raw bytes.
    assert.equal(persisted[1].content.trim(), textAfterStop.trim(), 'the persisted transcript matches what the UI is showing');
    // The click comes after the timer check, so how many chunks arrived varies; what was saved is still exactly the
    // first chunks, untrimmed.
    assert.ok(
      chunks.some((_, n) => n >= 2 && chunks.slice(0, n).join('') === persisted[1].content),
      `the exact accumulated delta text (untrimmed) is what got saved: ${JSON.stringify(persisted[1].content)}`,
    );

    process.stdout.write(`PASS Stop mid-stream keeps the partial reply visible and persists it exactly (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (!process.env.OPENAGENT_STOP_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL stop visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
