// Run with Electron, not node. Loads the real preload.cjs + built renderer, spawns the
// REAL worker.mjs (not a stub), and relays backend-message like main.cjs does — proves
// a real conversation end to end through the actual UI: open folder → type → send →
// streamed tool-start/message events → a real create_file write → assistant reply
// rendered as markdown, against a fake HTTP provider (same pattern as agent.test.mts).
const { app, BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
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

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return new Promise(resolve => process.stdout.write('', resolve));
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-chat-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const screenshotDir = process.env.OPENAGENT_CHAT_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    let requestCount = 0;
    server = createServer((request, response) => {
      requestCount++;
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        if (requestCount === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'notes.md', content: 'salut' }) } }] },
              finish_reason: 'tool_calls',
            }],
          }));
        } else {
          response.end(JSON.stringify({ choices: [{ message: { content: 'Fichier **notes.md** créé.' }, finish_reason: 'stop' }] }));
        }
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

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'global-settings') return { theme: 'dark', accent_color: '#3b82f6' };
      if (request.op === 'save-global-settings') return {};
      let outgoing = request;
      if (request.op === 'send') outgoing = { ...request, payload: { ...request.payload, connection } };
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
      });
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));

    // Open the (seeded) project folder through the real Sidebar button/dialog flow.
    await win.webContents.executeJavaScript("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(() => win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false",
    ));

    const inputPresent = await win.webContents.executeJavaScript(
      "!!document.getElementById('oa-input-ta')",
    );
    assert.ok(inputPresent, 'the real InputBar is present once a folder is active');

    // Type through the real InputBar and send via Enter, exactly like a user.
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'crée un fichier notes.md');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);

    const userBubbleShown = await waitFor(() => win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('div')).some(el => el.textContent === 'crée un fichier notes.md')",
    ));
    assert.ok(userBubbleShown, 'the user message renders immediately (optimistic, before any agent event)');

    const shotSending = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'chat-1-sending.png'), shotSending.toPNG());

    await waitFor(() => win.webContents.executeJavaScript(
      "!!document.querySelector('[data-testid=\"oa-tool-message\"]')",
    ));
    const toolBadge = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=\"oa-tool-message\"]')?.textContent",
    );
    assert.match(toolBadge, /WRITE/, 'the tool message shows the real WRITE category badge');
    assert.match(toolBadge, /create_file/, 'the tool message names the real tool that ran');

    const shotToolRan = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'chat-2-tool-ran.png'), shotToolRan.toPNG());

    // Two AI bubbles exist by now: the first (empty content) from the tool-call turn,
    // the second with the actual final reply — always check the last one.
    const assistantText = await waitFor(async () => {
      const text = await win.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''",
      );
      return text.includes('créé') ? text : null;
    });
    assert.match(assistantText, /notes\.md/, 'the assistant reply (rendered markdown) mentions the created file');

    const strongRendered = await win.webContents.executeJavaScript(
      "!!Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.querySelector('strong')",
    );
    assert.ok(strongRendered, 'markdown bold (**notes.md**) actually renders as a real <strong> element, not raw asterisks');

    const running = await win.webContents.executeJavaScript("document.getElementById('oa-send-btn')?.textContent");
    assert.equal(running, '➤', 'the send/stop button is back to its idle state once the run is done');

    const shotDone = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'chat-3-done.png'), shotDone.toPNG());

    const created = await readFile(join(project, 'notes.md'), 'utf8');
    assert.equal(created, 'salut', 'create_file actually wrote the real file on disk, through the real UI click path');

    process.stdout.write(`PASS real conversation through the UI creates a file and renders markdown (Electron ${process.versions.electron})\n`);
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
