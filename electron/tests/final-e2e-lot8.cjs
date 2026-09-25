// Plain Node script. Final end-to-end proof for the conversation export lot: spawns the REAL packaged executable
// (real main.cjs, real safeStorage vault, real worker), Python stripped from PATH, driven over the Chrome DevTools
// Protocol. A local HTTP server plays the model and answers a first turn with a real list_dir tool call. What only
// the packaged app proves: the real conversation (tool call included) is exported in the 3 formats from the ⬇ menu
// and from the palette, the files re-read from disk, and main.cjs's REAL `open-export` handler (shell.openPath)
// accepts the file just written and refuses anything else.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL8-SECRET';
const FINAL_ANSWER = 'Voici avec du code :\n\n```python\nx = "<b>"\n```\n';

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot8-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(userData)]);
  await writeFile(join(alpha, 'a.py'), 'print(1)\n');
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  // Fake model: a request whose last message is the user's asks for list_dir, the next one answers.
  const requests = [];
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ authorization: request.headers.authorization, body });
      const last = body.messages.at(-1);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (last.role === 'user') {
        response.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'call-lot8', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: FINAL_ANSWER }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9480;

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

    const js = (expression, awaitPromise = false) => app.cdp.evaluate(expression, awaitPromise);
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);
    // Toasts are appended, so the newest is last; never touch React-owned DOM from here.
    const newestToast = async pattern => {
      await waitFor(async () => pattern.test((await toasts()).at(-1)?.text ?? ''), { timeout: 10000 });
      return (await toasts()).at(-1);
    };
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const exported = async ext => (await readdir(alpha)).filter(name => new RegExp(`^conversation_\\d{8}_\\d{6}\\.${ext}$`).test(name));

    // ── Connect the scripted model, then have a REAL conversation with a real tool call ──
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
    await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'liste les fichiers');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await waitFor(async () => (await text('#oa-send-btn')) === '➤' && (await js(`document.body.textContent`)).includes('Voici avec du code'), { timeout: 20000 });
    record('PROOF 3 — a real turn on the packaged app: the scripted model called list_dir, the real tool ran, the model answered with a code block');

    // ── Proof 4: ⬇ menu, 3 real files, contents re-read from disk ────────────────
    await click('#oa-export-btn');
    await waitFor(() => exists('[data-testid="oa-export-menu"]'), { timeout: 5000 });
    assert.match(await text('[data-testid="oa-export-menu"]'), /Depuis : 🌿 Main/);
    await app.cdp.screenshot(join(proofDir, 'lot8-1-menu.png'));
    assert.ok(await exists('[data-testid="oa-export-menu"]'), 'the menu is still open after the screenshot');
    assert.ok(await exists('#oa-export-md'), `the Markdown entry exists (menu HTML: ${JSON.stringify((await js(`document.querySelector('[data-testid="oa-export-menu"]')?.outerHTML || ''`)).slice(0, 400))})`);
    await click('#oa-export-md');
    const mdToast = await newestToast(/^Exporté : conversation_\d{8}_\d{6}\.md$/);
    assert.equal(mdToast.kind, 'positive');
    const mdName = mdToast.text.replace('Exporté : ', '');
    const md = await readFile(join(alpha, mdName), 'utf8');
    assert.match(md, /^# Conversation — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
    assert.ok(md.includes(`Dossier : \`${alpha}\``));
    assert.match(md, /Modèle : `scripted-model`/);
    assert.match(md, /## 👤 Utilisateur\n\nliste les fichiers/);
    assert.match(md, /> \*\*\[READ\]\*\* `list_dir` —\n> .*a\.py/);
    assert.ok(md.includes('```python\nx = "<b>"\n```'));

    await click('#oa-export-btn');
    await click('#oa-export-html');
    const htmlName = (await newestToast(/\.html$/)).text.replace('Exporté : ', '');
    const html = await readFile(join(alpha, htmlName), 'utf8');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.ok(html.includes("<pre><code class='language-python'>x = &quot;&lt;b&gt;&quot;\n</code></pre>"));
    assert.equal(html.includes('&amp;lt;'), false, 'no double escaping');

    await click('#oa-export-btn');
    await click('#oa-export-json');
    const jsonName = (await newestToast(/\.json$/)).text.replace('Exporté : ', '');
    const data = JSON.parse(await readFile(join(alpha, jsonName), 'utf8'));
    assert.deepEqual(data.map(e => e.role), ['user', 'tool', 'ai']);
    assert.equal(data[1].tool_name, 'list_dir');
    assert.equal(data[1].tool_tag, 'read');
    assert.equal(data[1].tool_detail, '.');
    await app.cdp.screenshot(join(proofDir, 'lot8-2-exported.png'));
    record(`PROOF 4 — ⬇ menu on the packaged app: ${mdName}, ${htmlName}, ${jsonName} written at the project root and re-read (header, real [READ] tool line with a.py, code escaped once, JSON roles user/tool/ai with tool_name list_dir, tag read, detail ".")`);

    // ── Proof 5: the palette export (real Ctrl+K → Exporter) ─────────────────────
    await sleep(1100); // the file name's timestamp has second granularity
    await js(`document.getElementById('oa-input-ta').focus()`);
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await waitFor(() => exists('[data-testid="oa-palette"]'), { timeout: 5000 });
    await js(`document.querySelector('[data-testid="oa-palette-item"][data-command-id="export"]').click()`);
    await waitFor(() => exists('[data-testid="oa-export-dialog"]'), { timeout: 5000 });
    assert.match(await text('[data-testid="oa-export-dialog"]'), /Depuis : 🌿 Main/);
    await app.cdp.screenshot(join(proofDir, 'lot8-3-palette-dialog.png'));
    await click('#oa-export-dialog-md');
    const paletteName = (await newestToast(/^Exporté : conversation_\d{8}_\d{6}\.md$/)).text.replace('Exporté : ', '');
    assert.notEqual(paletteName, mdName);
    assert.ok((await readFile(join(alpha, paletteName), 'utf8')).includes('> **[READ]** `list_dir` —'));
    assert.equal((await exported('md')).length, 2);
    record(`PROOF 5 — "Exporter la conversation" from the palette (real Ctrl+K): dialog "Depuis : 🌿 Main", ${paletteName} written`);

    // ── Proof 6: main.cjs's REAL open-export handler ──────────────────────────────
    const request = (op, payload) => js(`window.openagent.request({ op: ${JSON.stringify(op)}, payload: ${JSON.stringify(payload)} }).then(r => ({ ok: true, r }), e => ({ ok: false, e: String(e.message || e) }))`, true);
    const refusedName = await request('open-export', { folder: alpha, filename: '..\\..\\Windows\\notepad.exe' });
    assert.equal(refusedName.ok, false, 'a path-like filename is refused');
    assert.match(refusedName.e, /Nom de fichier d’export invalide/);
    const refusedOther = await request('open-export', { folder: alpha, filename: 'a.py' });
    assert.equal(refusedOther.ok, false, 'a file that is not an export is refused');
    assert.match(refusedOther.e, /Nom de fichier d’export invalide/);
    const missing = await request('open-export', { folder: alpha, filename: 'conversation_19990101_000000.md' });
    assert.equal(missing.ok, false, 'a well-formed name of a file that does not exist: shell.openPath reports an error');
    // The real shell.openPath, on the file that was just exported (opens the OS default application for .json).
    // Opt-in only: it launches a real application on the developer's machine at every run.
    if (process.env.OPENAGENT_E2E_REAL_OPEN === '1') {
      const opened = await request('open-export', { folder: alpha, filename: jsonName });
      assert.deepEqual(opened, { ok: true, r: { opened: true } }, `the real shell.openPath accepted ${jsonName} (got ${JSON.stringify(opened)})`);
    }
    record(`PROOF 6 — main.cjs's real open-export: path-like name and non-export file refused ("${refusedName.e}"), missing export refused by shell.openPath ("${missing.e}")${process.env.OPENAGENT_E2E_REAL_OPEN === '1' ? `, ${jsonName} accepted by the real shell.openPath` : ' (real opening skipped: set OPENAGENT_E2E_REAL_OPEN=1)'}`);

    // ── Proof 7: no secret anywhere ───────────────────────────────────────────────
    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    for (const name of [...await exported('md'), ...await exported('html'), ...await exported('json')]) {
      assert.equal((await readFile(join(alpha, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    assert.ok(requests.length >= 2 && requests.every(r => r.authorization === `Bearer ${KEY}`), 'the vault key was on every model request');
    record('PROOF 7 — the API key appears in no data file and in none of the exports; it was on every model request');

    const code = await quit(app);
    record(`PROOF 8 — clean exit (exit code ${code})`);
    await writeFile(join(proofDir, 'lot8-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the conversation export lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot8-failure.png'));
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
  process.stderr.write(`FAIL final e2e lot8: ${error.stack || error}\n`);
  process.exitCode = 1;
});
