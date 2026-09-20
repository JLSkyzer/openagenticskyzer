// Plain Node script. Final end-to-end proof for the prompt library lot: spawns the REAL packaged executable
// (real main.cjs, real safeStorage vault, real worker), Python stripped from PATH, driven over the Chrome
// DevTools Protocol with REAL keyboard and mouse events. A local HTTP server plays the model and records
// what it receives. What only the packaged app can prove: the packaged worker serves the library, the "/"
// key goes through Chromium's own keyboard pipeline without leaving a stray character, the prompt chosen
// reaches the model unchanged, and a prompts.json edited by hand is read again after a real restart.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL6-SECRET';
const DEFAULT_IDS = ['refactor', 'tests', 'explain', 'pr_desc', 'debug', 'optimize', 'security', 'review', 'document', 'translate'];
const SECURITY = 'Effectue un audit de sécurité complet de mon-projet.\nVérifie : injection, XSS, CSRF, secrets exposés, dépendances vulnérables, OWASP Top 10.';

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  // ── Proof 1: no Python on the PATH the app is launched with ─────────────────────
  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot6-'));
  const home = join(root, 'home');
  const project = join(root, 'mon-projet');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(project), mkdir(userData)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));

  // Fake model: records every request, always answers "bien reçu".
  const requests = [];
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'bien reçu' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9370;

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
    const itemIds = () => js(`[...document.querySelectorAll('[data-testid="oa-prompt-item"]')].map(e => e.dataset.promptId)`);
    const inputValue = () => js(`document.getElementById('oa-input-ta').value`);
    const setInput = value => js(`(() => { const el = document.getElementById('oa-input-ta'); el.value = ${JSON.stringify(value)}; el.focus(); })()`);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const closedNow = async () => !(await exists('[data-testid="oa-prompt-picker"]'));
    const openPicker = async () => {
      await click('#oa-prompt-btn');
      await waitFor(() => exists('[data-testid="oa-prompt-picker"]'));
      await waitFor(async () => (await itemIds()).length > 0 || await exists('[data-testid="oa-prompt-empty"]'));
    };
    // Real keyboard events, dispatched to the browser like a physical key (not a synthetic DOM event).
    const key = async (name, code, vk, text) => {
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, text });
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
    };
    const mouseClick = async (x, y) => {
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };

    // ── Connect the scripted model through the real dialog (real encrypted vault) ────
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-model-btn'));
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-model-active"]'));
    await setValue('[data-model-field="model"]', 'scripted-model');
    await setValue('[data-model-field="base_url"]', `http://127.0.0.1:${modelPort}/v1`);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await waitFor(async () => /Connexion enregistrée/.test(await text('[data-testid="oa-model-status"]')));
    await click('#oa-model-close-btn');

    // ── Proof 3: ✦ opens the library served by the PACKAGED worker: the ten defaults ─
    await waitFor(() => exists('#oa-prompt-btn'));
    await openPicker();
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'the ten defaults, in order');
    assert.match(await text('[data-testid="oa-prompt-item"]'), /Refactoriser/);
    await app.cdp.screenshot(join(proofDir, 'lot6-1-picker.png'));
    record('PROOF 3 — real click on ✦: the packaged worker serves the ten defaults, in order');

    // ── Proof 4: filter, then choosing a prompt fills the box with the folder name ──
    await setValue('#oa-prompt-filter', 'SÉCURITÉ');
    assert.deepEqual(await itemIds(), ['security'], 'filter on the name, whatever the case and accent');
    await js(`document.querySelector('[data-testid="oa-prompt-item"][data-prompt-id="security"]').click()`);
    await waitFor(closedNow);
    assert.equal(await inputValue(), SECURITY, '{filename} became the active folder name');
    await app.cdp.screenshot(join(proofDir, 'lot6-2-applied.png'));
    record('PROOF 4 — filter "SÉCURITÉ" found the prompt; choosing it filled the box with "mon-projet" in place of {filename}');

    // ── Proof 5: the prompt reaches the model unchanged when sent ────────────────
    await key('Enter', 'Enter', 13, '\r');
    await waitFor(() => requests.length > 0, { timeout: 20000 });
    const sent = requests.at(-1);
    assert.equal(sent.authorization, `Bearer ${KEY}`, 'the vault key was on the request');
    const userMessage = sent.body.messages.filter(m => m.role === 'user').at(-1);
    assert.equal(userMessage.content, SECURITY, 'the model received exactly the filled-in prompt');
    await waitFor(async () => (await text('#oa-send-btn')) === '➤', { timeout: 20000 });
    await app.cdp.screenshot(join(proofDir, 'lot6-3-sent.png'));
    record('PROOF 5 — Enter sent it: the model received exactly the filled-in prompt (with the vault key), nothing added or lost');

    // ── Proof 6: a real "/" key opens the library without typing the slash ───────
    await setInput('');
    await key('/', 'Slash', 191, '/');
    await waitFor(() => exists('[data-testid="oa-prompt-picker"]'), { timeout: 5000 });
    await sleep(250);
    assert.equal(await inputValue(), '', 'no stray "/" in the box');
    assert.equal(await js(`document.getElementById('oa-prompt-filter').value`), '', 'nor in the filter');
    await key('Escape', 'Escape', 27);
    await waitFor(closedNow);
    assert.equal(await js(`document.activeElement?.id`), 'oa-input-ta', 'Escape closed it and gave the box its focus back');
    await setInput('abc');
    await key('/', 'Slash', 191, '/');
    await sleep(300);
    assert.equal(await exists('[data-testid="oa-prompt-picker"]'), false);
    assert.equal(await inputValue(), 'abc/', 'in a non-empty box the slash is an ordinary character');
    record('PROOF 6 — real "/" key: opens the library from an empty box with no stray character; Escape closes it; a non-empty box just gets the slash');

    // ── Proof 7: the backdrop closes it, a click inside the card does not ────────
    await openPicker();
    const title = await js(`(() => { const r = document.querySelector('[data-testid="oa-prompt-picker"] span').getBoundingClientRect(); return { x: Math.round(r.left + 5), y: Math.round(r.top + 5) }; })()`);
    await mouseClick(title.x, title.y);
    await sleep(300);
    assert.equal(await exists('[data-testid="oa-prompt-picker"]'), true, 'a click inside the card keeps it open');
    await mouseClick(8, 8);
    await waitFor(closedNow);
    record('PROOF 7 — real mouse: a click inside the card keeps it open, a click on the backdrop closes it');

    // ── Proof 8: prompts.json edited by hand is used at once, and after a real restart ──
    await writeFile(join(home, 'prompts.json'), JSON.stringify([
      { id: 'a', name: 'Alpha', icon: '🔧', description: 'Premier prompt', template: 'Relis {filename} puis {filename}' },
      { id: 'b', name: 'Bravo', template: 'Sans icône ni description' },
    ]));
    await openPicker();
    assert.deepEqual(await itemIds(), ['a', 'b'], 'the file written while the app runs is read at once');
    assert.match(await text('[data-testid="oa-prompt-item"][data-prompt-id="b"]'), /📝/);
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);
    const code = await quit(app);
    record(`PROOF 8a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-prompt-btn'));
    await openPicker();
    assert.deepEqual(await itemIds(), ['a', 'b'], 'the custom library is still served after the restart');
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);
    record('PROOF 8 — prompts.json edited by hand: seen at once, and still served by the packaged worker after a real restart');

    // ── Proof 9: a corrupt file never breaks the picker ──────────────────────────
    await writeFile(join(home, 'prompts.json'), JSON.stringify(['not', 'a', 'dict']));
    await openPicker();
    assert.deepEqual(await itemIds(), DEFAULT_IDS, 'the shape that crashed the NiceGUI filter falls back on the defaults');
    await click('#oa-prompt-close-btn');
    await waitFor(closedNow);
    record('PROOF 9 — a malformed prompts.json falls back on the ten defaults, the picker keeps working');

    const code2 = await quit(app);
    record(`PROOF 10 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot6-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the prompt library lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot6-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 700))}\n`);
    } catch { /* the page may be gone */ }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await new Promise(resolve => { modelServer.closeAllConnections?.(); modelServer.close(() => resolve()); });
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot6: ${error.stack || error}\n`);
  process.exitCode = 1;
});
