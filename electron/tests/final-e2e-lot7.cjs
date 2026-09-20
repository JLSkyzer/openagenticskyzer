// Plain Node script. Final end-to-end proof for the command palette lot: spawns the REAL packaged executable
// (real main.cjs, real safeStorage vault, real worker), Python stripped from PATH, driven over the Chrome
// DevTools Protocol with REAL keyboard events (Ctrl+K through Chromium's own pipeline). A local HTTP server plays
// the model. What only the packaged app proves: Ctrl+K from the input box, the memory window served by the
// packaged worker, the compaction command carrying the vault key (added by main.cjs, never by the page), a
// confirmed history clearing that survives a real restart, and the refusal to clear under a running turn.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL7-SECRET';
const ALL_IDS = ['open-folder', 'switch-model', 'clear-history', 'open-settings', 'show-memory', 'open-prompts', 'compact'];

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

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot7-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(join(alpha, '.openagent'), { recursive: true }), mkdir(userData)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  await writeFile(join(alpha, '.openagent', 'memory.md'), '<!-- 2026-09-23 10:00 -->\n# Faits\n- utilise **pnpm**\n- écrit en français\n');
  // A legacy conversation of 6 messages, imported by the app as the main branch.
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i % 2 === 0 ? 'q' : 'r'}${Math.floor(i / 2) + 1}-${'x'.repeat(300)}` }));
  await writeFile(join(alpha, '.openagent', 'chat_history.json'), JSON.stringify(history));

  // Fake model: a summary for a summary request, "réponse N" otherwise (which can be held); records Authorization.
  const requests = [];
  const held = [];
  const state = { holdTurn: false, count: 0 };
  let onHeld = null;
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const isSummary = !body.tools && body.messages.length === 1 && String(body.messages[0].content).startsWith('Résume cette conversation');
      requests.push({ isSummary, authorization: request.headers.authorization, body });
      const answer = () => {
        const content = isSummary ? '- décision : garder la branche A' : `réponse ${++state.count}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      };
      if (!isSummary && state.holdTurn) { held.push(answer); onHeld?.(); } else answer();
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;
  const summaries = () => requests.filter(r => r.isSummary);

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9380;

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
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const paletteIds = () => js(`[...document.querySelectorAll('[data-testid="oa-palette-item"]')].map(e => e.dataset.commandId)`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8'));
    const mainOnDisk = async () => (await disk()).branches.find(b => b.id === 'main').messages;
    // Ctrl+K as a physical key: dispatched to the browser, so it goes through Chromium's keyboard pipeline.
    const ctrlK = async () => {
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    };
    const openPalette = async () => {
      await ctrlK();
      await waitFor(() => exists('[data-testid="oa-palette"]'), { timeout: 5000 });
    };
    const runCommand = async id => {
      if (!(await exists('[data-testid="oa-palette"]'))) await openPalette();
      await js(`document.querySelector('[data-testid="oa-palette-item"][data-command-id="${id}"]').click()`);
      await waitFor(async () => !(await exists('[data-testid="oa-palette"]')));
    };
    const key = async (name, code, vk, txt) => {
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, text: txt });
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
    };

    // ── Proof 3: Ctrl+K from the input box, before any folder is open ────────────
    await waitFor(() => exists('#oa-input-ta'));
    await js(`document.getElementById('oa-input-ta').focus()`);
    await ctrlK();
    await waitFor(() => exists('[data-testid="oa-palette"]'), { timeout: 5000 });
    assert.equal(await js(`document.getElementById('oa-input-ta').value`), '', 'the k was not typed into the box');
    assert.equal(await js(`document.activeElement?.id`), 'oa-palette-input');
    assert.deepEqual(await paletteIds(), ALL_IDS, 'the seven commands, in order');
    await app.cdp.screenshot(join(proofDir, 'lot7-1-palette.png'));
    await setValue('#oa-palette-input', 'mémoire');
    assert.deepEqual(await paletteIds(), ['show-memory']);
    await key('Enter', 'Enter', 13, '\r');
    await waitFor(async () => (await toasts()).some(t => t.text === 'Aucun dossier actif.' && t.kind === 'warning'), { timeout: 5000 });
    record('PROOF 3 — real Ctrl+K from the input box (no "k" typed); seven commands in order; typing + real Enter ran the memory command, which refused without a folder (yellow toast)');

    // ── Open the folder, then connect the scripted model through the selector the PALETTE opens ──
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-model-btn'));
    await runCommand('switch-model');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { timeout: 5000 });
    await setValue('[data-model-field="model"]', 'scripted-model');
    await setValue('[data-model-field="base_url"]', `http://127.0.0.1:${modelPort}/v1`);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await waitFor(async () => /Connexion enregistrée/.test(await text('[data-testid="oa-model-status"]')));
    await click('#oa-model-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')));
    await waitFor(async () => (await userBubbles()).length === 3, { timeout: 10000 });
    record('PROOF 4 — "Changer de modèle" from the palette opened the real selector: the scripted model was saved in the encrypted vault; the legacy history (3 exchanges) was imported');

    // ── Proof 5: the memory window, served by the packaged worker ─────────────────
    await runCommand('show-memory');
    await waitFor(() => exists('[data-testid="oa-memory-content"]'), { timeout: 8000 });
    assert.equal(await js(`document.querySelector('[data-testid="oa-memory-content"] strong')?.textContent`), 'pnpm', 'Markdown rendered: bold');
    const shown = await text('[data-testid="oa-memory-content"]');
    assert.match(shown, /écrit en français/);
    assert.doesNotMatch(shown, /2026-09-23|<!--/, `the dated marker is hidden (shown: ${JSON.stringify(shown)})`);
    await app.cdp.screenshot(join(proofDir, 'lot7-2-memory.png'));
    await click('#oa-memory-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-memory-dialog"]')));
    record('PROOF 5 — "Voir la mémoire projet": memory.md rendered as Markdown by the packaged worker (bold), the dated HTML marker hidden');

    // ── Proof 6: settings and prompt library from the palette ────────────────────
    await runCommand('open-settings');
    await waitFor(() => exists('[data-testid="oa-settings-dialog"]'), { timeout: 5000 });
    await click('#oa-settings-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-settings-dialog"]')));
    await runCommand('open-prompts');
    await waitFor(() => exists('[data-testid="oa-prompt-picker"]'), { timeout: 5000 });
    await click('#oa-prompt-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-prompt-picker"]')));
    record('PROOF 6 — "Paramètres" and "Bibliothèque de prompts" opened their real windows from the palette');

    // ── Proof 7: "Compacter le contexte" — the vault key reaches the summary request ──
    await runCommand('compact');
    await waitFor(async () => (await mainOnDisk()).length === 3, { timeout: 20000 });
    assert.equal(summaries().length, 1);
    assert.equal(summaries()[0].authorization, `Bearer ${KEY}`, 'the vault key was added by main.cjs');
    assert.equal(summaries()[0].body.tools, undefined, 'no tool offered to the summariser');
    const compacted = await mainOnDisk();
    assert.match(compacted[0].content, /^\*\*\[Résumé de contexte compressé\]\*\*\n\n- décision : garder la branche A/);
    assert.deepEqual(compacted.slice(1), history.slice(-2), 'the last exchange is kept');
    record('PROOF 7 — "Compacter le contexte": summary + last exchange on disk, the vault key was on the request, no tool');

    // ── Proof 8: clearing while a turn runs is refused; nothing is lost ───────────
    state.holdTurn = true;
    const heldTurn = new Promise(resolve => { onHeld = resolve; });
    await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'en cours');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await heldTurn;
    await waitFor(async () => (await text('#oa-send-btn')) === '■', { timeout: 8000 });
    const untouched = JSON.stringify(await mainOnDisk());
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'), { timeout: 5000 });
    await click('#oa-palette-clear-ok-btn');
    await waitFor(async () => (await toasts()).some(t => t.kind === 'negative' && /en cours/.test(t.text)), { timeout: 8000 });
    assert.equal(JSON.stringify(await mainOnDisk()), untouched, 'nothing was cleared under the running turn');
    await app.cdp.screenshot(join(proofDir, 'lot7-3-refused.png'));
    state.holdTurn = false;
    for (const answer of held.splice(0)) answer();
    await waitFor(async () => (await text('#oa-send-btn')) === '➤', { timeout: 20000 });
    record('PROOF 8 — "Vider l\'historique" while a turn runs: refused with a red toast, the conversation on disk untouched');

    // ── Proof 9: cancel keeps everything, confirm clears — and survives a real restart ──
    const beforeCancel = JSON.stringify(await mainOnDisk());
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'), { timeout: 5000 });
    assert.ok((await text('[data-testid="oa-clear-confirm"]')).includes(alpha), 'the confirmation names the folder');
    await click('#oa-palette-clear-cancel-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-clear-confirm"]')));
    assert.equal(JSON.stringify(await mainOnDisk()), beforeCancel, 'Annuler cleared nothing');
    await runCommand('clear-history');
    await waitFor(() => exists('[data-testid="oa-clear-confirm"]'), { timeout: 5000 });
    await click('#oa-palette-clear-ok-btn');
    await waitFor(async () => (await toasts()).some(t => t.text === 'Historique effacé.' && t.kind === 'positive'), { timeout: 8000 });
    assert.deepEqual(await mainOnDisk(), []);
    await waitFor(async () => (await userBubbles()).length === 0);
    await app.cdp.screenshot(join(proofDir, 'lot7-4-cleared.png'));
    const code = await quit(app);
    record(`PROOF 9a — cancelled then confirmed: history empty on disk and on screen; the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-input-ta'));
    await sleep(500);
    assert.deepEqual(await userBubbles(), [], 'still empty after the restart');
    await js(`document.getElementById('oa-input-ta').focus()`);
    await ctrlK();
    await waitFor(() => exists('[data-testid="oa-palette"]'), { timeout: 5000 });
    assert.deepEqual(await paletteIds(), ALL_IDS, 'Ctrl+K works after the restart too');
    await key('Escape', 'Escape', 27);
    record('PROOF 9 — after a real restart the cleared history stays cleared and Ctrl+K still opens the palette');

    // The API key only lives in the vault: in no JSON file of the data directory nor in the conversation.
    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    assert.equal((await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).includes(KEY), false);
    record('PROOF 10 — the API key appears in no JSON file of the data directory nor in the conversation');

    const code2 = await quit(app);
    record(`PROOF 11 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot7-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the command palette lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot7-failure.png'));
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
  process.stderr.write(`FAIL final e2e lot7: ${error.stack || error}\n`);
  process.exitCode = 1;
});
