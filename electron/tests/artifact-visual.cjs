// Run with Electron, not node. Proves the artifact preview panel end to end, with the REAL renderer, the REAL
// worker.mjs, the REAL `oa-artifact:` protocol (artifact-protocol.cjs) and — unlike the other component tests —
// the app's REAL Content-Security-Policy (buildCsp from main.cjs), because an <iframe srcdoc> inherits that policy
// and would silently lose its inline script: only with the policy in place can this test tell. A fake model
// answers with blocks of every kind. Frames are inspected from the main process (frame.executeJavaScript), which
// is how the isolation is PROVED rather than assumed: the page script cannot reach the parent, the network, or
// navigate the window; an SVG's script never runs. Nothing here opens an external application.
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const artifactProtocol = require('../artifact-protocol.cjs');
artifactProtocol.registerScheme(protocol); // before ready
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');
const { buildCsp } = require('../main.cjs');

async function waitFor(fn, { timeout = 15000, interval = 50, what = 'condition' } = {}) {
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

// What the fake model answers, by the text of the user's message.
const REPLIES = {
  html: 'Voici :\n```html\n<body><p id="x">départ</p><script>\n' +
    'document.getElementById("x").textContent = "script-ran";\n' +
    'window.__probe = {};\n' +
    'try { parent.document.title; __probe.parent = "reached"; } catch (e) { __probe.parent = e.name; }\n' +
    'try { top.location.href = "https://example.invalid/"; __probe.nav = "attempted"; } catch (e) { __probe.nav = e.name; }\n' +
    'fetch("http://127.0.0.1:PORT/leak").then(() => { __probe.fetch = "reached"; }, () => { __probe.fetch = "blocked"; });\n' +
    'try { parent.document.title = "pwned"; } catch (e) {}\n' +
    '</script></body>\n```',
  svg: 'Un dessin :\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="document.body.setAttribute(\'data-onload\',\'1\')">' +
    '<script>document.body.setAttribute("data-script","1")</script><circle id="c" cx="30" cy="30" r="20" fill="#7c3aed"/></svg>\n```',
  mermaid: 'Un schéma :\n```mermaid\ngraph TD\n  A[Début] --> B[Fin]\n```',
  cassé: 'Un schéma cassé :\n```mermaid\ngraph TD\n  A[[[ --> ???\n```',
  markdown: 'Une note :\n```markdown\n# Titre de la note\n\n- point **gras**\n```',
  rien: 'Juste du texte, aucun bloc.',
};

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-artifact-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta)]);
  const screenshotDir = process.env.OPENAGENT_ARTIFACT_SCREENSHOT_DIR || home;
  const pageMessages = [];
  let lastFrameHtml = ''; // declared before the try: the catch prints it
  let win;
  let server;
  let worker;
  try {
    const strayRequests = []; // anything the model server receives that is not a chat completion
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) { strayRequests.push(`${request.method} ${request.url}`); response.writeHead(404); response.end(); return; }
        const body = JSON.parse(raw);
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user').content;
        const port = server.address().port;
        const reply = (REPLIES[lastUser] ?? 'ok').replace('PORT', String(port));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
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

    // The real protocol and the app's real policy — the same two things main.cjs installs.
    const store = artifactProtocol.createArtifactStore();
    artifactProtocol.installHandler(protocol, store);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith(`${artifactProtocol.SCHEME}:`)) { callback({}); return; }
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(true)] } });
    });

    let nextFolder = alpha;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return nextFolder;
      if (request.op === 'artifact-put') return store.put(request.payload?.kind, request.payload?.html);
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
    const titleBefore = win.webContents.getTitle();

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const send = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const ask = async (message, turns) => {
      await send(message);
      await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-assistant-bubble"]').length`)) === turns && await isIdle(), { what: `reply to ${message}` });
    };
    const artifactFrame = () => win.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(`${artifactProtocol.SCHEME}:`));
    const frameEval = async code => {
      const frame = await waitFor(() => artifactFrame(), { what: 'artifact frame' });
      try { return await frame.executeJavaScript(code); }
      catch (error) { throw new Error(`frame script failed (${frame.url.slice(0, 40)}): ${code.replace(/\s+/g, ' ').slice(0, 100)} — ${error.message}`); }
    };
    // A frame with sandbox="" runs no script at all, and Electron rightly refuses to inject one into it ("Script not
    // run"): its document is read through the DevTools DOM protocol instead, which needs no script.
    // The artifact frame is out of process: attach the debugger to each iframe target as it is created.
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const frameSessions = [];
    dbg.on('message', (_event, method, params) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') frameSessions.push(params.sessionId);
    });
    await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const frameHtml = async () => {
      for (const sessionId of [...frameSessions].reverse()) { // newest frame first
        try {
          const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 }, sessionId);
          const { outerHTML } = await dbg.sendCommand('DOM.getOuterHTML', { nodeId: root.nodeId }, sessionId);
          if (outerHTML) { lastFrameHtml = outerHTML; return outerHTML; }
        } catch { /* that frame is gone (the panel replaced it): try the previous one */ }
      }
      lastFrameHtml = `(no readable artifact frame; ${frameSessions.length} iframe target(s) seen)`;
      return '';
    };
    const openFolder = async name => {
      nextFolder = name === 'alpha' ? alpha : beta;
      await click('#oa-open-folder-btn');
      await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].some(e => e.textContent.includes(${JSON.stringify(name)}))`), { what: `folder ${name} listed` });
      await pause(400);
    };

    await openFolder('alpha');
    assert.equal(await exists('[data-testid="oa-artifact-panel"]'), false, 'no panel before any artifact');

    // ── 1. HTML: opens the panel, the inline script RUNS under the app's CSP, and can reach nothing ────────────
    await ask('html', 1);
    await waitFor(() => exists('[data-testid="oa-artifact-frame"]'), { what: 'html frame' });
    assert.equal(await text('[data-testid="oa-artifact-title"]'), 'Preview — HTML');
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-frame"]').getAttribute('sandbox')`), 'allow-scripts', 'allow-scripts and NOTHING else (no allow-same-origin)');
    assert.equal(await js(`Math.round(document.querySelector('[data-testid="oa-artifact-panel"]').getBoundingClientRect().width)`), 400);
    await waitFor(async () => (await frameEval(`document.getElementById('x').textContent`)) === 'script-ran', { what: 'the inline script ran' });
    const probe = await waitFor(async () => { const p = await frameEval('window.__probe'); return p && p.fetch ? p : null; }, { what: 'probe finished' });
    assert.equal(probe.parent, 'SecurityError', 'the page is not reachable from the artifact');
    assert.notEqual(probe.nav, 'attempted', 'the artifact cannot navigate the window away');
    assert.equal(probe.fetch, 'blocked', 'the artifact has no network');
    assert.equal(win.webContents.getTitle(), titleBefore, 'the artifact did not change the page title');
    assert.equal(await js(`document.location.protocol`), 'file:', 'the window was not navigated');
    assert.deepEqual(strayRequests, [], 'nothing reached the network server other than the chat itself');
    await writeFile(join(screenshotDir, 'artifact-1-html.png'), await capturePng(win));

    // ── 2. SVG: shown, and its scripts never run ───────────────────────────────────────────────────────────────
    await ask('svg', 2);
    await waitFor(async () => (await text('[data-testid="oa-artifact-title"]')) === 'Preview — SVG', { what: 'svg panel' });
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-frame"]').getAttribute('sandbox')`), '', 'sandbox="" — no script permission at all');
    const svgDocument = await waitFor(async () => { const html = await frameHtml(); return html.includes('id="c"') ? html : null; }, { what: 'svg drawn' });
    // The words "data-script"/"data-onload" appear in the SOURCE of the svg's own script and onload: what proves
    // they did not run is that the <body> never received the attributes they would have set.
    const bodyTag = /<body[^>]*>/.exec(svgDocument)?.[0] ?? '';
    assert.ok(bodyTag.includes('padding:16px'), `found the body tag (${bodyTag})`);
    assert.doesNotMatch(bodyTag, /data-/, 'neither the <script> nor onload ran: the body never got the attributes they set');
    assert.match(svgDocument, /<script>document\.body\.setAttribute\("data-script"/, 'while their source is really there, in the document');
    await assert.rejects(frameEval('1 + 1'), /Script not run|frame script failed/, 'and Electron itself cannot run a script in that frame');
    await writeFile(join(screenshotDir, 'artifact-2-svg.png'), await capturePng(win));

    // ── 3. Mermaid: rendered as a diagram ──────────────────────────────────────────────────────────────────────
    await ask('mermaid', 3);
    await waitFor(async () => (await text('[data-testid="oa-artifact-title"]')) === 'Preview — MERMAID', { what: 'mermaid panel' });
    const diagram = await waitFor(async () => { const html = await frameHtml(); return html.includes('<svg') ? html : null; }, { timeout: 30000, what: 'mermaid svg drawn' });
    assert.match(diagram, /Début/);
    assert.match(diagram, /Fin/);
    await writeFile(join(screenshotDir, 'artifact-3-mermaid.png'), await capturePng(win));

    // ── 4. A broken diagram says so instead of breaking the page ─────────────────────────────────────────────────
    await ask('cassé', 4);
    await waitFor(() => exists('[data-testid="oa-artifact-error"]'), { timeout: 30000, what: 'mermaid error shown' });
    assert.match(await text('[data-testid="oa-artifact-error"]'), /^Diagramme Mermaid invalide/);
    assert.equal(await exists('[data-testid="oa-chat-error"]'), false, 'the chat itself is fine');
    assert.equal(await js(`document.querySelectorAll('[id^="doa-mermaid"]').length`), 0, 'mermaid left no temporary element behind');

    // ── 5. Markdown: rendered in the panel, no frame ─────────────────────────────────────────────────────────────
    await ask('markdown', 5);
    await waitFor(() => exists('[data-testid="oa-artifact-markdown"]'), { what: 'markdown panel' });
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-markdown"] h1')?.textContent`), 'Titre de la note');
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-markdown"] strong')?.textContent`), 'gras');
    assert.equal(await exists('[data-testid="oa-artifact-frame"]'), false);

    // ── 6. A reply with no block leaves the open panel alone ─────────────────────────────────────────────────────
    await ask('rien', 6);
    assert.equal(await text('[data-testid="oa-artifact-title"]'), 'Preview — MARKDOWN', 'unchanged');

    // ── 7. ✕ closes it ───────────────────────────────────────────────────────────────────────────────────────────
    await click('[data-testid="oa-artifact-close"]');
    await waitFor(async () => !(await exists('[data-testid="oa-artifact-panel"]')), { what: 'closed by ✕' });

    // ── 8. Another project does not inherit the preview ───────────────────────────────────────────────────────────
    await ask('html', 7);
    await waitFor(() => exists('[data-testid="oa-artifact-panel"]'), { what: 'reopened' });
    await openFolder('beta');
    await waitFor(async () => !(await exists('[data-testid="oa-artifact-panel"]')), { what: 'the panel does not follow into beta' });
    await writeFile(join(screenshotDir, 'artifact-4-after.png'), await capturePng(win));

    process.stdout.write(`PASS artifact panel: html script runs under the app CSP but reaches neither the page, the window nor the network; svg script inert; mermaid rendered and errors contained; markdown; ✕; per-project (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'artifact-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-12))}\n`);
      process.stderr.write(`Last artifact frame document: ${JSON.stringify(lastFrameHtml.slice(0, 600))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    server?.closeAllConnections?.();
    server?.close();
    if (!process.env.OPENAGENT_ARTIFACT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL artifact visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
