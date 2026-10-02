// Plain Node script. Final end-to-end proof for the local .gguf provider lot: spawns the REAL packaged executable
// (real main.cjs, real worker, Python stripped from PATH) driven over the Chrome DevTools Protocol with REAL mouse
// events. What only the packaged app proves: node-llama-cpp's native binary really loads and runs from inside
// app.asar.unpacked (not just from raw node_modules in dev), a real .gguf produces real text through the real UI
// with NO remote connection configured, the choice survives a REAL restart, and the API key of an unrelated
// connection never leaks into a local turn. The native file picker is not clicked (a system dialog nothing can
// drive) — the library is seeded through the real worker op instead, exactly like every other final-e2e script
// seeds its data directory rather than clicking "Ouvrir un dossier". Nothing here opens an external application.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, copyFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL13-SECRET';

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot13-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(userData)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const modelPath = join(root, 'stories260K.gguf');
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), modelPath);

  // An unrelated remote connection is also configured, to prove its key never reaches a local turn.
  let requests = 0;
  const remoteServer = createServer((request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'ne devrait jamais être vu' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve, reject) => { remoteServer.once('error', reject); remoteServer.listen(0, '127.0.0.1', resolve); });
  const remotePort = remoteServer.address().port;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9980;

  async function launch() {
    const port = debugPort++;
    const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: python.sanitizedPath, OPENAGENT_HOME: home, OPENAGENT_DISABLE_UPDATES: '1' },
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

    const js = expression => app.cdp.evaluate(expression, true);
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const isIdle = async () => (await text('#oa-send-btn')) === '➤';
    const request = (op, payload) => js(`window.openagent.request({ op: ${JSON.stringify(op)}, payload: ${JSON.stringify(payload)} }).then(r => ({ ok: true, r }), e => ({ ok: false, e: String(e.message || e) }))`);
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

    // The real worker op adds the real .gguf BEFORE the dialog is ever opened, so its local-models list
    // (which loads once on mount) sees it from the start.
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-model-btn'));
    const added = await request('gguf-add', { path: modelPath });
    assert.equal(added.ok, true, JSON.stringify(added));

    // ── Configure an unrelated remote connection first (its key must never leak into the local turn) ──
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { timeout: 5000 });
    await setValue('[data-model-field="model"]', 'remote-model');
    await setValue('[data-model-field="base_url"]', `http://127.0.0.1:${remotePort}/v1`);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await waitFor(async () => /Connexion enregistrée/.test(await text('[data-testid="oa-model-status"]')));

    // ── Proof 3: the real .gguf is in the library, a real click activates it ──────────────────────────
    await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-local-model-entry"]')].some(e => e.textContent.includes('stories260K.gguf'))`), { timeout: 8000 });
    await click('[data-testid="oa-local-model-select"]');
    await waitFor(async () => /Modèle actif/.test(await text('[data-testid="oa-model-active"]')) && /local/.test(await text('[data-testid="oa-model-active"]')));
    await click('#oa-model-close-btn');
    await waitFor(async () => /stories260K/.test(await text('#oa-model-btn')));
    record('PROOF 3 — packaged: the real .gguf was added to the library and a real click activated it — the button and the banner both show it');

    // ── Proof 4: a real turn on the real engine, loaded from app.asar.unpacked, no remote call at all ─
    await send('Once upon a time');
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-assistant-bubble"]').length`)) === 1 && await isIdle(), { timeout: 60000 });
    const reply = (await text('[data-testid="oa-assistant-bubble"]')).trim();
    assert.ok(reply.length > 0, 'real text from the real local engine');
    assert.notEqual(reply, 'ne devrait jamais être vu', 'the remote provider was never called');
    assert.equal(requests, 0, 'the remote server received nothing at all');
    await app.cdp.screenshot(join(proofDir, 'lot13-1-replied.png'));
    record(`PROOF 4 — packaged: real text from node-llama-cpp loaded out of app.asar.unpacked, and the unrelated remote connection was never touched (0 requests)`);

    // ── Proof 5: the choice survives a REAL restart ────────────────────────────────────────────────────
    const code = await quit(app);
    record(`PROOF 5a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => app.cdp.evaluate(`!!document.querySelector('[data-testid="oa-folder-entry"]')`), { timeout: 15000 });
    await app.cdp.evaluate(`document.querySelector('[data-testid="oa-folder-entry"]').click()`);
    await waitFor(async () => /stories260K/.test(await text('#oa-model-btn')), { timeout: 15000 });
    await app.cdp.screenshot(join(proofDir, 'lot13-2-after-restart.png'));
    record('PROOF 5 — after a real restart the local model is still the active one');

    // No secret anywhere.
    for (const name of await require('node:fs/promises').readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    record('PROOF 6 — the remote connection\'s API key appears in no data file');

    const code2 = await quit(app);
    record(`PROOF 7 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot13-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the local .gguf provider lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot13-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) { process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`); }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await new Promise(resolve => { remoteServer.closeAllConnections?.(); remoteServer.close(() => resolve()); });
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot13: ${error.stack || error}\n`);
  process.exitCode = 1;
});
