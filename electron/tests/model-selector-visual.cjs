// Run with Electron, not node. Proves the model selector end to end through the real built
// renderer with the REAL encrypted vault (safeStorage), the REAL resolveSendPayload from
// main.cjs and the REAL worker.mjs: what is saved in the dialog is what the next message
// actually uses (server, model, API key), the key never returns to the page nor reaches
// the vault file in clear text, and re-binding a saved key to another URL needs an
// explicit confirmation. Two local fake HTTP providers stand in for real vendors.
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

function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const SECRET = 'sk-A-SECRET';
const LONG_MODEL = 'model-a-with-a-really-long-name';

// A minimal OpenAI-compatible streaming endpoint that records what it was asked.
function fakeProvider(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, model: JSON.parse(body).model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\r\n\r\n`);
      response.write('data: [DONE]\r\n\r\n');
      response.end();
    });
  });
  return { requests, server };
}
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-model-'));
  const home = join(root, 'home');
  const project = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(project)]);
  process.env.OPENAGENT_HOME = home;
  const screenshotDir = process.env.OPENAGENT_MODEL_SCREENSHOT_DIR || home;
  const providerA = fakeProvider('reponse-du-serveur-A');
  const providerB = fakeProvider('reponse-du-serveur-B');
  let win;
  let worker;
  try {
    const portA = await listen(providerA.server);
    const portB = await listen(providerB.server);
    const urlA = `http://127.0.0.1:${portA}/v1`;
    const urlB = `http://127.0.0.1:${portB}/v1`;

    const { createConnections, resolveSendPayload } = require('../main.cjs');
    const connections = await createConnections();

    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    // Same routing as main.cjs::handleBackendRequest, minus the window-sender check.
    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return project;
      if (request.op === 'connection-snapshot') return connections.snapshot(request.payload?.folder ?? null);
      if (request.op === 'save-connection') return connections.save(request.payload?.folder ?? null, request.payload?.patch, request.payload?.authorization);
      const outgoing = request.op === 'send' ? await resolveSendPayload(connections, request) : request;
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
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const field = name => `[data-model-field="${name}"]`;
    const fieldValue = name => js(`document.querySelector(${JSON.stringify(field(name))}).value`);
    const bodyText = () => js('document.body.textContent');
    const openDialog = async () => { await click('#oa-model-btn'); await pause(300); };
    const closeDialog = async () => { await click('#oa-model-close-btn'); await pause(150); };
    const snapshot = () => js(`window.openagent.request({ op: 'connection-snapshot', payload: { folder: ${JSON.stringify(project)} } })`);
    const sendMessage = async message => {
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
    };
    const waitForText = async expected => {
      for (let i = 0; i < 60; i++) {
        if ((await bodyText()).includes(expected)) return;
        await pause(150);
      }
      throw new Error(`timed out waiting for "${expected}" on screen`);
    };

    await click('#oa-open-folder-btn');
    await pause(500);

    // ── Nothing configured yet ────────────────────────────────────────────────────
    assert.match(await text('#oa-model-btn'), /Aucun modèle/, 'the input bar button says no model is set');
    await openDialog();
    assert.match(await text('[data-testid="oa-model-active"]'), /Aucun modèle sélectionné/);
    assert.equal(await fieldValue('provider'), 'openrouter');

    // ── Save server A with a key ──────────────────────────────────────────────────
    await setValue(field('model'), LONG_MODEL);
    await setValue(field('base_url'), urlA);
    await setValue(field('api_key'), SECRET);
    await click('#oa-model-save-btn');
    await pause(500);
    assert.match(await text('[data-testid="oa-model-status"]'), /Connexion enregistrée/);
    assert.match(await text('[data-testid="oa-model-active"]'), new RegExp(LONG_MODEL));
    assert.equal(await fieldValue('api_key'), '', 'the key field is emptied after saving');
    assert.match(await js(`document.querySelector(${JSON.stringify(field('api_key'))}).placeholder`), /configurée/, 'a stored key is shown as configured, never as its value');
    const vaultRaw = await readFile(join(home, 'connections.v1.json'), 'utf8');
    assert.equal(vaultRaw.includes(SECRET), false, 'the vault file holds no clear-text key');
    assert.equal((await bodyText()).includes(SECRET), false, 'the key is nowhere on the page');
    await closeDialog();
    assert.equal(await text('#oa-model-btn'), `● ${LONG_MODEL.slice(0, 20)}… ▾`, 'the button truncates the name to 20 characters like input_bar.py');
    assert.equal(await js(`document.getElementById('oa-model-btn').title`), LONG_MODEL, 'the tooltip carries the full name');

    // ── The next message really goes to server A with model A and key A ───────────
    await sendMessage('Bonjour A');
    await waitForText('reponse-du-serveur-A');
    assert.deepEqual(providerA.requests, [{ authorization: `Bearer ${SECRET}`, model: LONG_MODEL }], 'server A got the saved model and the saved key');
    assert.equal(providerB.requests.length, 0);

    // ── Re-binding the key to server B needs an explicit confirmation ─────────────
    await openDialog();
    assert.equal(await fieldValue('base_url'), urlA, 'the dialog shows the saved URL');
    await setValue(field('base_url'), urlB);
    await click('#oa-model-save-btn');
    await pause(500);
    assert.equal(await exists('#oa-model-confirm-ok-btn'), true, 'a saved key cannot be sent to another URL without confirmation');
    assert.match(await text('[data-testid="oa-model-confirm"]'), new RegExp(`127\\.0\\.0\\.1:${portB}`), 'the confirmation names the new URL');
    await writeFile(join(screenshotDir, 'model-confirm.png'), await capturePng(win));
    await click('#oa-model-confirm-cancel-btn');
    await pause(200);
    assert.equal((await snapshot()).base_url, urlA, 'Annuler left the connection on server A');
    await click('#oa-model-save-btn');
    await pause(500);
    await click('#oa-model-confirm-ok-btn');
    await pause(500);
    assert.equal((await snapshot()).base_url, urlB, 'confirming moved the connection to server B');
    assert.match(await text('[data-testid="oa-model-status"]'), /Connexion enregistrée/);
    await closeDialog();

    await sendMessage('Bonjour B');
    await waitForText('reponse-du-serveur-B');
    assert.deepEqual(providerB.requests, [{ authorization: `Bearer ${SECRET}`, model: LONG_MODEL }], 'server B now receives the request, with the same stored key');
    assert.equal(providerA.requests.length, 1, 'server A got nothing more');

    // ── Switch provider (no key needed locally), then come back and drop the key ──
    await openDialog();
    await setValue(field('provider'), 'ollama');
    await setValue(field('model'), 'qwen2.5-coder');
    await click('#oa-model-save-btn');
    await pause(500);
    const local = await snapshot();
    assert.equal(local.provider, 'ollama');
    assert.equal(local.model, 'qwen2.5-coder');
    assert.equal(local.base_url, 'http://localhost:11434/v1', 'ollama defaults to its own local endpoint');
    assert.equal(local.key_configured, false, 'the openrouter key is not shared with ollama');
    assert.match(await text('#oa-model-btn'), /qwen2\.5-coder/);

    await setValue(field('provider'), 'openrouter');
    await click('#oa-model-save-btn');
    await pause(500);
    const back = await snapshot();
    assert.equal(back.provider, 'openrouter');
    assert.equal(back.model, LONG_MODEL, 'the openrouter profile kept its own model');
    assert.equal(back.key_configured, true, 'and its key');
    await click('#oa-model-clear-key-btn');
    await click('#oa-model-save-btn');
    await pause(500);
    assert.equal((await snapshot()).key_configured, false, 'Retirer la clé really removes it');
    assert.doesNotMatch(await js(`document.querySelector(${JSON.stringify(field('api_key'))}).placeholder`), /configurée/);

    process.stdout.write(`PASS model selector: saved model/URL/key drive the next message, key never returns, URL re-binding needs confirmation (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshot: ${join(screenshotDir, 'model-confirm.png')}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    await Promise.all([providerA.server, providerB.server].map(server => new Promise(resolve => server.close(() => resolve()))));
    if (!process.env.OPENAGENT_MODEL_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL model selector visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
