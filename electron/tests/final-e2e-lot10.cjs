// Plain Node script. Final end-to-end proof for the artifact preview lot: spawns the REAL packaged executable (real
// main.cjs — which registers the `oa-artifact:` scheme and installs the app's real Content-Security-Policy — real
// worker, Python stripped from PATH), driven over the Chrome DevTools Protocol. A local HTTP server plays the
// model and answers with html / svg / mermaid blocks. What only the packaged app proves: the protocol is really
// registered and its documents keep their OWN policy (not overwritten by the app's), the HTML artifact's inline
// script runs yet reaches neither the page, the window nor the network, an SVG's script never runs, and the Mermaid
// chunks load from the archive under the strict packaged policy. Nothing here opens an external application.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL10-SECRET';

const REPLIES = {
  html: 'Voici :\n```html\n<body><p id="x">départ</p><script>\n' +
    'document.getElementById("x").textContent = "script-ran";\n' +
    'window.__probe = {};\n' +
    'try { parent.document.title; __probe.parent = "reached"; } catch (e) { __probe.parent = e.name; }\n' +
    'fetch("http://127.0.0.1:PORT/leak").then(() => { __probe.fetch = "reached"; }, () => { __probe.fetch = "blocked"; });\n' +
    '</script></body>\n```',
  svg: 'Un dessin :\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="document.body.setAttribute(\'data-onload\',\'1\')">' +
    '<script>document.body.setAttribute("data-script","1")</script><circle id="c" cx="30" cy="30" r="20" fill="#7c3aed"/></svg>\n```',
  mermaid: 'Un schéma :\n```mermaid\ngraph TD\n  A[Début] --> B[Fin]\n```',
};

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot10-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(userData)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  const strayRequests = [];
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) { strayRequests.push(`${request.method} ${request.url}`); response.writeHead(404); response.end(); return; }
      const body = JSON.parse(raw);
      const lastUser = [...body.messages].reverse().find(m => m.role === 'user').content;
      const reply = (REPLIES[lastUser] ?? 'ok').replace('PORT', String(modelServer.address().port));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9680;

  async function launch() {
    const port = debugPort++;
    const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: python.sanitizedPath, OPENAGENT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => childOutput.push(`[stdout] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr] ${d}`));
    const instance = { child, port, exited: false, cdp: null };
    instance.exitPromise = new Promise(resolve => child.on('exit', code => { instance.exited = true; running.delete(instance); resolve(code); }));
    running.add(instance);
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000 });
    instance.cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await instance.cdp.send('Page.enable');
    await instance.cdp.send('Runtime.enable');
    return instance;
  }
  async function quit(instance) {
    try { instance.cdp.close(); } catch { /* already closed */ }
    const version = await httpGetJson(`http://127.0.0.1:${instance.port}/json/version`);
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    await browser.send('Browser.close').catch(() => {});
    const code = await Promise.race([instance.exitPromise, sleep(20000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'the app exited after the window was closed');
    return code;
  }

  let app;
  try {
    app = await launch();
    record(`PROOF 2 — packaged executable launched directly (pid=${app.child.pid}), no npm start, isolated OPENAGENT_HOME and userData`);

    const js = expression => app.cdp.evaluate(expression);
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const isIdle = async () => (await text('#oa-send-btn')) === '➤';
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const send = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const ask = async (message, turns) => {
      await send(message);
      await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-assistant-bubble"]').length`)) === turns && await isIdle(), { timeout: 20000 });
    };
    // The artifact frame is its own DevTools target (out of process): connect to it directly.
    const frameCdp = async () => {
      const target = await waitFor(async () => {
        const list = await httpGetJson(`http://127.0.0.1:${app.port}/json`);
        return list.filter(t => t.url.startsWith('oa-artifact:')).at(-1);
      }, { timeout: 15000 });
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      return cdp;
    };

    // ── Connect the scripted model (vault) ───────────────────────────────────────
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-model-btn'));
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { timeout: 5000 });
    await setValue('[data-model-field="model"]', 'scripted-model');
    await setValue('[data-model-field="base_url"]', `http://127.0.0.1:${modelPort}/v1`);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await waitFor(async () => /Connexion enregistrée/.test(await text('[data-testid="oa-model-status"]')));
    await click('#oa-model-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')));
    const titleBefore = await js('document.title');
    const urlBefore = await js('location.href');

    // ── Proof 3: HTML artifact ─────────────────────────────────────────────────────
    await ask('html', 1);
    await waitFor(() => exists('[data-testid="oa-artifact-frame"]'), { timeout: 15000 });
    assert.equal(await text('[data-testid="oa-artifact-title"]'), 'Preview — HTML');
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-frame"]').getAttribute('sandbox')`), 'allow-scripts');
    assert.match(await js(`document.querySelector('[data-testid="oa-artifact-frame"]').src`), /^oa-artifact:\/\/a\/[0-9a-f-]{36}$/);
    let frame = await frameCdp();
    await waitFor(async () => (await frame.evaluate(`document.getElementById('x')?.textContent`)) === 'script-ran', { timeout: 10000 });
    const probe = await waitFor(async () => { const p = await frame.evaluate('window.__probe'); return p && p.fetch ? p : null; }, { timeout: 10000 });
    assert.equal(probe.parent, 'SecurityError');
    assert.equal(probe.fetch, 'blocked');
    assert.equal(await js('document.title'), titleBefore);
    assert.equal(await js('location.href'), urlBefore, 'the window was not navigated');
    assert.deepEqual(strayRequests, [], 'nothing reached the network server other than the chat');
    await app.cdp.screenshot(join(proofDir, 'lot10-1-html.png'));
    frame.close();
    record('PROOF 3 — packaged: the HTML artifact\'s inline script RAN under the app\'s strict CSP (own document policy kept, not overwritten); it could not read the page (SecurityError), its fetch was blocked, the window and title are untouched, the network server saw only the chat');

    // ── Proof 4: SVG with a script and onload ─────────────────────────────────────
    await ask('svg', 2);
    await waitFor(async () => (await text('[data-testid="oa-artifact-title"]')) === 'Preview — SVG', { timeout: 10000 });
    assert.equal(await js(`document.querySelector('[data-testid="oa-artifact-frame"]').getAttribute('sandbox')`), '');
    frame = await frameCdp();
    const svgHtml = await waitFor(async () => {
      const { root } = await frame.send('DOM.getDocument', { depth: -1 });
      const { outerHTML } = await frame.send('DOM.getOuterHTML', { nodeId: root.nodeId });
      return outerHTML.includes('id="c"') ? outerHTML : null;
    }, { timeout: 10000 });
    const bodyTag = /<body[^>]*>/.exec(svgHtml)?.[0] ?? '';
    assert.ok(bodyTag.includes('padding:16px'));
    assert.doesNotMatch(bodyTag, /data-/, 'neither the <script> nor onload ran');
    await app.cdp.screenshot(join(proofDir, 'lot10-2-svg.png'));
    frame.close();
    record('PROOF 4 — packaged: the SVG is drawn and its <script> and onload never ran (the body never received the attributes they set)');

    // ── Proof 5: Mermaid, loaded from the archive under the packaged policy ──────
    await ask('mermaid', 3);
    await waitFor(async () => (await text('[data-testid="oa-artifact-title"]')) === 'Preview — MERMAID', { timeout: 10000 });
    frame = await frameCdp();
    const diagram = await waitFor(async () => {
      const { root } = await frame.send('DOM.getDocument', { depth: -1 });
      const { outerHTML } = await frame.send('DOM.getOuterHTML', { nodeId: root.nodeId });
      return outerHTML.includes('<svg') ? outerHTML : null;
    }, { timeout: 30000 });
    assert.match(diagram, /Début/);
    assert.match(diagram, /Fin/);
    await app.cdp.screenshot(join(proofDir, 'lot10-3-mermaid.png'));
    frame.close();
    record('PROOF 5 — packaged: the Mermaid chunks loaded from the archive under the strict policy and the diagram was rendered (Début → Fin)');

    // ── Proof 6: real click on ✕ ───────────────────────────────────────────────────
    const { x, y } = await js(`(() => { const r = document.querySelector('[data-testid="oa-artifact-close"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await waitFor(async () => !(await exists('[data-testid="oa-artifact-panel"]')), { timeout: 5000 });
    record('PROOF 6 — real click on ✕ closed the panel');

    // ── Proof 7: the packaged main process refuses what it should ─────────────────
    const request = (op, payload) => app.cdp.evaluate(`window.openagent.request({ op: ${JSON.stringify(op)}, payload: ${JSON.stringify(payload)} }).then(r => ({ ok: true, r }), e => ({ ok: false, e: String(e.message || e) }))`, true);
    assert.equal((await request('artifact-put', { kind: 'script', html: 'x' })).ok, false, 'an unknown kind is refused');
    assert.equal((await request('artifact-put', { kind: 'html', html: 'x'.repeat(2 * 1024 * 1024 + 1) })).ok, false, 'an oversized document is refused');
    const fine = await request('artifact-put', { kind: 'html', html: '<p>ok</p>' });
    assert.equal(fine.ok, true);
    record('PROOF 7 — the packaged main process refuses an unknown kind and a document over 2 MB, and accepts a normal one');

    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    record('PROOF 8 — the API key appears in no data file');

    const code = await quit(app);
    record(`PROOF 9 — clean exit (exit code ${code})`);
    await writeFile(join(proofDir, 'lot10-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the artifact preview lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot10-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) { process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`); }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await new Promise(resolve => { modelServer.closeAllConnections?.(); modelServer.close(() => resolve()); });
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot10: ${error.stack || error}\n`);
  process.exitCode = 1;
});
