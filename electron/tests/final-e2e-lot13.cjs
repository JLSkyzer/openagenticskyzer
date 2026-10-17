// Plain Node script. Final end-to-end proof of the local-only models lot on the REAL packaged executable (real
// main.cjs, real worker, Python stripped from PATH), driven over the Chrome DevTools Protocol. The data home is
// seeded as an upgrade from an online-provider version would leave it: a connections vault and its backup, config.json
// with current_provider / current_model / hf_token, and a .gguf library holding a copy of stories260K.gguf, made active.
// What only the packaged app proves: the startup erases the vault and the provider keys (hf_token kept), the model
// button shows the .gguf, a really typed message gets a reply from node-llama-cpp loaded out of app.asar.unpacked,
// no model form exists, and main.cjs's REAL open-export handler opens an export it wrote and refuses anything else
// (main-side name check, then shell.openPath on a missing file). The allowed open launches the OS default
// application for .json once: it is the only proof of the real shell.openPath. Every launch sets
// OPENAGENT_DISABLE_UPDATES. Run ONCE, all output to a file.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir, copyFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const VAULT_SECRET = 'sk-FINAL13-VAULT-SECRET';
const HF_TOKEN = 'hf_FINAL13_KEPT_TEST_VALUE';

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
  await writeFile(join(alpha, 'a.py'), 'print(1)\n');
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  // ── Seed: what an online-provider version left behind, plus a real .gguf already active ──────────────
  const modelPath = join(root, 'stories260K.gguf');
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), modelPath);
  const modelId = randomUUID();
  await writeFile(join(home, 'gguf-library.json'), JSON.stringify([
    { id: modelId, name: 'stories260K.gguf', path: modelPath, size_bytes: (await stat(modelPath)).size, added_at: new Date().toISOString() },
  ]));
  const vault = JSON.stringify({ version: 1, connections: [{ id: 'remote', base_url: 'https://example.invalid/v1', api_key: VAULT_SECRET }] });
  await writeFile(join(home, 'connections.v1.json'), vault);
  await writeFile(join(home, 'connections.v1.json.pre-electron.bak'), vault);
  await writeFile(join(home, 'config.json'), JSON.stringify({
    current_provider: 'openrouter', current_model: 'remote/model-FINAL13', hf_token: HF_TOKEN, active_local_model: modelId,
  }));

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  const debugPort = 9980;

  async function launch() {
    const child = spawn(exePath, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: python.sanitizedPath, OPENAGENT_HOME: home, OPENAGENT_DISABLE_UPDATES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => childOutput.push(`[stdout] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr] ${d}`));
    const instance = { child, port: debugPort, exited: false, cdp: null };
    instance.exitPromise = new Promise(resolve => child.on('exit', code => { instance.exited = true; running.delete(instance); resolve(code); }));
    running.add(instance);
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${debugPort}/json`);
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
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);

    // ── Proof 3: the startup erased the vault family and the provider keys, and kept hf_token ─────────
    // The page is up, so main.cjs's startup (erasure before the worker starts) has run.
    const names = await readdir(home);
    assert.equal(names.some(name => name.startsWith('connections.v1.json')), false, `vault family gone: ${JSON.stringify(names)}`);
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal('current_provider' in config, false, 'current_provider erased');
    assert.equal('current_model' in config, false, 'current_model erased');
    assert.equal(config.hf_token, HF_TOKEN, 'hf_token kept');
    assert.equal(config.active_local_model, modelId, 'the active .gguf kept');
    for (const name of await readdir(home)) {
      const info = await stat(join(home, name));
      if (info.isFile()) assert.equal((await readFile(join(home, name), 'utf8')).includes(VAULT_SECRET), false, `${name} holds no vault secret`);
    }
    record(`PROOF 3 — after start: connections.v1.json and its backup gone, current_provider/current_model erased, hf_token and active_local_model kept; no file of the data home holds the vault secret (files: ${JSON.stringify(names)})`);

    // ── Proof 4: the model button shows the active .gguf; no model form exists ─────────────────────────
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(async () => /stories260K\.gguf/.test(await text('#oa-model-btn')), { timeout: 15000 });
    const buttonLabel = await text('#oa-model-btn');
    await click('#oa-model-btn');
    await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-local-model-entry"]')].some(e => e.textContent.includes('stories260K.gguf'))`), { timeout: 8000 });
    const formFields = await js(`document.querySelectorAll('[data-model-field]').length`);
    assert.equal(formFields, 0, 'the model dialog has no provider form');
    await app.cdp.screenshot(join(proofDir, 'lot13-1-model-dialog.png'));
    await click('#oa-model-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-local-model-entry"]')), { timeout: 5000 });
    record(`PROOF 4 — model button « ${buttonLabel.trim()} »; the dialog lists stories260K.gguf and holds ${formFields} [data-model-field] (no model form)`);

    // ── Proof 5: a really typed message and Enter get a reply from the real local engine ───────────────
    await js(`document.getElementById('oa-input-ta').focus()`);
    await app.cdp.send('Input.insertText', { text: 'Once upon a time' });
    assert.equal(await js(`document.getElementById('oa-input-ta').value`), 'Once upon a time', 'the text was typed into the input');
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-assistant-bubble"]').length`)) === 1 && await isIdle(), { timeout: 60000 });
    const reply = (await text('[data-testid="oa-assistant-bubble"]')).trim();
    assert.ok(reply.length > 0, 'real text from the real local engine');
    const status = await request('model-status', {});
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.r.loaded, true, `model-status after the turn: ${JSON.stringify(status.r)}`);
    assert.equal(status.r.name, 'stories260K.gguf');
    await app.cdp.screenshot(join(proofDir, 'lot13-2-replied.png'));
    record(`PROOF 5 — typed « Once upon a time » + Enter: reply ${JSON.stringify(reply.slice(0, 80))} from node-llama-cpp loaded out of app.asar.unpacked; model-status ${JSON.stringify(status.r)}`);

    // ── Proof 6: main.cjs's REAL open-export handler (retired from lot8 by Task 3, proven here) ─────────
    await click('#oa-export-btn');
    await click('#oa-export-json');
    await waitFor(async () => /^Exporté : conversation_\d{8}_\d{6}\.json$/.test((await toasts()).at(-1)?.text ?? ''), { timeout: 10000 });
    const jsonName = (await toasts()).at(-1).text.replace('Exporté : ', '');
    assert.ok((await stat(join(alpha, jsonName))).isFile(), `${jsonName} written at the project root`);
    const refusedPath = await request('open-export', { folder: alpha, filename: '..\\..\\Windows\\notepad.exe' });
    assert.equal(refusedPath.ok, false, 'a path-like filename is refused');
    assert.match(refusedPath.e, /Nom de fichier d’export invalide/);
    const refusedOther = await request('open-export', { folder: alpha, filename: 'a.py' });
    assert.equal(refusedOther.ok, false, 'a file that is not an export is refused by main');
    assert.match(refusedOther.e, /Nom de fichier d’export invalide/);
    const missing = await request('open-export', { folder: alpha, filename: 'conversation_19990101_000000.md' });
    assert.equal(missing.ok, false, 'a well-formed name of a file that does not exist: shell.openPath reports an error');
    assert.doesNotMatch(missing.e, /Nom de fichier d’export invalide/, 'the missing file passed the name check and was refused by shell.openPath');
    const opened = await request('open-export', { folder: alpha, filename: jsonName });
    assert.deepEqual(opened, { ok: true, r: { opened: true } }, `the real shell.openPath accepted ${jsonName} (got ${JSON.stringify(opened)})`);
    record(`PROOF 6 — main.cjs's real open-export: ${jsonName} opened by the real shell.openPath; path-like name and a.py refused by main ("${refusedPath.e}"); missing export refused by shell.openPath ("${missing.e}")`);

    const code = await quit(app);
    record(`PROOF 7 — clean exit (exit code ${code})`);
    await writeFile(join(proofDir, 'lot13-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the local-only models lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot13-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) { process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`); }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot13: ${error.stack || error}\n`);
  process.exitCode = 1;
});
