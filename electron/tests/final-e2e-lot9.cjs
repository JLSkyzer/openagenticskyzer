// Plain Node script. Final end-to-end proof for the edit / regenerate lot: spawns the REAL packaged executable
// (real main.cjs, real safeStorage vault, real worker), Python stripped from PATH, driven over the Chrome DevTools
// Protocol with REAL mouse events. A local HTTP server plays the model and records what it is sent. What only the
// packaged app proves: 🔄 and ✏️ work through the real IPC (main.cjs adds the vault key to the send that carries
// `keep`), the reply being replaced is never sent to the model, an edit leaves the disk alone until something is
// sent, and what was saved survives a real restart. Nothing here opens an external application.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL9-SECRET';

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot9-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(userData)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  // Fake model: the Nth request answers "réponse N"; every request is recorded with its Authorization header.
  const requests = [];
  let count = 0;
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const n = ++count;
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: `réponse ${n}` }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;
  const sentToModel = index => JSON.stringify(requests[index].body.messages.map(m => m.content));

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9580;

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
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const boxValue = () => js(`document.getElementById('oa-input-ta').value`);
    const isIdle = async () => (await text('#oa-send-btn')) === '➤';
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).branches.find(b => b.id === 'main').messages.map(m => m.content);
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
    // A physical click through Chromium's own input pipeline, at the centre of the last element matching the selector.
    const realClick = async selector => {
      const { x, y } = await js(`(() => {
        const list = document.querySelectorAll(${q(selector)});
        const r = list[list.length - 1].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };

    // ── Connect the scripted model (vault), then two real turns ──────────────────
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
    await send('premier');
    await waitFor(async () => (await assistantBubbles()).length === 1 && await isIdle(), { timeout: 20000 });
    await send('second');
    await waitFor(async () => (await assistantBubbles()).length === 2 && await isIdle(), { timeout: 20000 });
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 2']);
    record('PROOF 3 — two real turns on the packaged app with the vault key; conversation on disk: premier / réponse 1 / second / réponse 2');

    // ── Proof 4: real click on 🔄 ─────────────────────────────────────────────────
    assert.equal(await countOf('[data-testid="oa-edit-btn"]'), 2);
    assert.equal(await countOf('[data-testid="oa-regenerate-btn"]'), 1);
    await realClick('[data-testid="oa-regenerate-btn"]');
    await waitFor(async () => (await disk()).at(-1) === 'réponse 3' && await isIdle(), { timeout: 20000 });
    assert.equal(requests[2].authorization, `Bearer ${KEY}`, 'the vault key was added by main.cjs to the regenerating send');
    assert.equal(sentToModel(2).includes('réponse 2'), false, 'the reply being replaced was not sent to the model');
    assert.ok(sentToModel(2).includes('second') && sentToModel(2).includes('réponse 1'));
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 3']);
    await app.cdp.screenshot(join(proofDir, 'lot9-1-regenerated.png'));
    record('PROOF 4 — real click on 🔄: the model was asked again without the old reply, the vault key was on the request, the disk holds "réponse 3" in its place');

    // ── Proof 5: real click on ✏️ — the disk is untouched until something is sent ─────────────────────────────
    await realClick('[data-testid="oa-edit-btn"]');
    await waitFor(async () => (await boxValue()) === 'second' && (await userBubbles()).length === 1, { timeout: 8000 });
    assert.equal(await js(`document.activeElement?.id`), 'oa-input-ta');
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second', 'réponse 3'], 'nothing was cut on disk');
    await app.cdp.screenshot(join(proofDir, 'lot9-2-editing.png'));
    record('PROOF 5 — real click on ✏️: "second" is back in the focused box, the view is cut, the disk still holds the full conversation');

    // ── Proof 6: send the edited text — the saved tail is replaced ────────────────────────────────────────────
    await send('second (édité)');
    await waitFor(async () => (await disk()).at(-1) === 'réponse 4' && await isIdle(), { timeout: 20000 });
    assert.equal(requests[3].authorization, `Bearer ${KEY}`);
    assert.equal(sentToModel(3).includes('réponse 3'), false, 'the cut tail was not sent');
    assert.equal(sentToModel(3).includes('"second"'), false, 'the old wording was not sent');
    assert.deepEqual(await disk(), ['premier', 'réponse 1', 'second (édité)', 'réponse 4']);
    assert.deepEqual(await userBubbles(), ['premier', 'second (édité)']);
    record('PROOF 6 — the edited text was sent with the cut applied: the model saw neither the old wording nor the old reply, the disk holds the edited turn');

    // ── Proof 7: a real restart keeps exactly that ────────────────────────────────────────────────────────────
    const code = await quit(app);
    record(`PROOF 7a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => app.cdp.evaluate(`!!document.querySelector('[data-testid="oa-folder-entry"]')`));
    await app.cdp.evaluate(`document.querySelector('[data-testid="oa-folder-entry"]').click()`);
    await waitFor(async () => (await app.cdp.evaluate(`document.querySelectorAll('[data-testid="oa-user-bubble"]').length`)) === 2, { timeout: 10000 });
    assert.deepEqual(await app.cdp.evaluate(`[...document.querySelectorAll('[data-testid="oa-user-bubble"]')].map(e => e.textContent)`), ['premier', 'second (édité)']);
    assert.deepEqual(await app.cdp.evaluate(`[...document.querySelectorAll('[data-testid="oa-assistant-bubble"]')].map(e => e.textContent)`), ['réponse 1', 'réponse 4']);
    record('PROOF 7 — after a real restart the edited conversation is shown exactly as saved');

    // No secret in any data file.
    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    assert.equal((await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).includes(KEY), false);
    record('PROOF 8 — the API key appears in no data file nor in the conversation');

    const code2 = await quit(app);
    record(`PROOF 9 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot9-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the edit / regenerate lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot9-failure.png'));
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
  process.stderr.write(`FAIL final e2e lot9: ${error.stack || error}\n`);
  process.exitCode = 1;
});
