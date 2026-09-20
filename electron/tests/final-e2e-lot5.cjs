// Plain Node script. Final end-to-end proof for the context gauge + compaction lot: spawns the REAL
// packaged executable (real main.cjs, real safeStorage vault, real worker), Python stripped from PATH,
// driven over the Chrome DevTools Protocol. A local HTTP server plays the model. What only the packaged
// app can prove: the API key reaches the summary request through main.cjs (never through the page), the
// gauge follows the real connection's provider, and the compacted conversation survives a real restart.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL5-SECRET';
// The provider chosen in the model dialog is openrouter: its assumed window, minus the default reserved tokens.
const OPENROUTER_WINDOW = 128_000;
const RESERVED = 2048;

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

  const home = await mkdtemp(join(tmpdir(), 'openagent-lot5-home-'));
  const alpha = await mkdtemp(join(tmpdir(), 'openagent-lot5-alpha-'));
  const beta = await mkdtemp(join(tmpdir(), 'openagent-lot5-beta-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-lot5-userdata-'));
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: alpha, last_used: new Date().toISOString() },
    { path: beta, last_used: new Date(Date.now() - 1000).toISOString() },
  ]));
  // A conversation of 6 messages × 800 characters, in the legacy chat_history.json format the app imports.
  const history = (count, length) => Array.from({ length: count }, (_, i) => {
    const tag = i % 2 === 0 ? `q${i / 2 + 1}-` : `r${(i - 1) / 2 + 1}-`;
    return { role: i % 2 === 0 ? 'user' : 'assistant', content: tag + 'x'.repeat(length - tag.length) };
  });
  await mkdir(join(alpha, '.openagent'), { recursive: true });
  await writeFile(join(alpha, '.openagent', 'chat_history.json'), JSON.stringify(history(6, 800)));

  // What the gauge must say, from the messages on disk (4 characters per token, user + assistant only).
  const expected = (messages, maxTokens) => {
    const chars = messages.filter(m => m.role === 'user' || m.role === 'assistant').reduce((sum, m) => sum + [...m.content].length, 0);
    const tokens = Math.floor(chars / 4);
    const limit = Math.max(1, (maxTokens || OPENROUTER_WINDOW) - RESERVED);
    return `${Math.round(Math.min(100, (tokens / limit) * 100))}% · ~${tokens.toLocaleString('en-US')} tokens`;
  };

  // Fake model: distinguishes a summary request (no tool, one "Résume…" message) from a normal turn, and
  // records the Authorization header of each request.
  const requests = [];
  const state = { summary: 'ok', normalCount: 0 };
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const isSummary = !body.tools && body.messages.length === 1 && String(body.messages[0].content).startsWith('Résume cette conversation');
      requests.push({ body, isSummary, authorization: request.headers.authorization });
      if (isSummary && state.summary === 'fail') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"boom"}'); return; }
      const content = isSummary ? '- décision : garder la branche A\n- fichier modifié : notes.md' : `réponse ${++state.normalCount}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;
  const summaries = () => requests.filter(r => r.isSummary);

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9360;

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
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const gaugeLabel = () => text('[data-testid="oa-context-label"]');
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8'));
    const mainOnDisk = async () => (await disk()).branches.find(b => b.id === 'main').messages;
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)})).click()`);
    const send = async message => {
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
    };
    // The real settings dialog: Contexte tab, set what is asked, Enregistrer, close.
    const setContextSettings = async ({ threshold, maxTokens, auto }) => {
      await click('#oa-settings-btn');
      await waitFor(() => exists('[data-testid="oa-settings-tab"][data-tab="context"]'));
      await click('[data-testid="oa-settings-tab"][data-tab="context"]');
      await sleep(250);
      if (maxTokens !== undefined) await setValue('[data-setting="max_tokens"]', maxTokens);
      if (threshold !== undefined) await setValue('[data-setting="compact_threshold"]', threshold);
      if (auto !== undefined && (await js(`document.querySelector('[data-setting="auto_compact"]').checked`)) !== auto) await click('[data-setting="auto_compact"]');
      await click('#oa-settings-save-btn');
      await waitFor(async () => /Paramètres sauvegardés/.test(await text('[data-testid="oa-settings-status"]')));
      await click('#oa-settings-close-btn');
      await sleep(400);
    };

    // ── Open the folder, connect the scripted model through the real dialog (real encrypted vault) ──
    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`));
    await enter('alpha');
    await waitFor(() => exists('#oa-model-btn'));
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-model-active"]'));
    await setValue('[data-model-field="model"]', 'scripted-model');
    await setValue('[data-model-field="base_url"]', `http://127.0.0.1:${modelPort}/v1`);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await waitFor(async () => /Connexion enregistrée/.test(await text('[data-testid="oa-model-status"]')));
    await click('#oa-model-close-btn');

    // ── Proof 3: the legacy chat_history.json is imported and the gauge reads the real provider ──
    await waitFor(async () => (await userBubbles()).length === 3, { timeout: 10000 });
    const legacy = JSON.parse(await readFile(join(alpha, '.openagent', 'chat_history.json'), 'utf8'));
    await waitFor(async () => (await gaugeLabel()) === expected(legacy, null), { timeout: 8000 });
    assert.equal(await gaugeLabel(), '1% · ~1,200 tokens', 'openrouter window (128 000) minus 2 048 reserved: 1 200 tokens is about 1 %');
    assert.equal(await exists('#oa-compact-btn'), false);
    await app.cdp.screenshot(join(proofDir, 'lot5-1-gauge.png'));
    record('PROOF 3 — legacy chat_history.json imported; the gauge follows the real connection (openrouter): "1% · ~1,200 tokens", recomputed from the file');

    // ── Proof 4: settings dialog → gauge changes live (max_tokens 4000, threshold 50) ──
    await setContextSettings({ maxTokens: 4000, threshold: 50, auto: false });
    assert.equal(await gaugeLabel(), expected(legacy, 4000));
    assert.equal(await gaugeLabel(), '61% · ~1,200 tokens');
    await waitFor(() => exists('#oa-compact-btn'), { timeout: 5000 });
    await app.cdp.screenshot(join(proofDir, 'lot5-2-button.png'));
    record('PROOF 4 — real settings dialog: gauge went to 61 % and the ⚡ button appeared at once, without restart');

    // ── Proof 5: real click compacts; the API key reached the summary request through main.cjs ──
    await click('#oa-compact-btn');
    await waitFor(() => exists('[data-testid="oa-notice"]'), { timeout: 20000 });
    assert.equal(await text('[data-testid="oa-notice"]'), 'Contexte compressé avec résumé IA.');
    assert.equal(summaries().length, 1);
    const summaryRequest = summaries()[0];
    assert.equal(summaryRequest.authorization, `Bearer ${KEY}`, 'the vault key was injected by main.cjs into the summary request');
    assert.equal(summaryRequest.body.tools, undefined, 'no tool offered to the summariser');
    const compacted = await mainOnDisk();
    assert.equal(compacted.length, 3);
    assert.match(compacted[0].content, /^\*\*\[Résumé de contexte compressé\]\*\*\n\n- décision : garder la branche A/);
    assert.deepEqual(compacted.slice(1), legacy.slice(-2), 'the last exchange is kept untouched');
    assert.deepEqual(await userBubbles(), [legacy.at(-2).content]);
    assert.equal(await gaugeLabel(), expected(compacted, 4000));
    const all = [...await readdir(home, { recursive: true }), ...await readdir(join(alpha, '.openagent'), { recursive: true })];
    assert.equal(all.some(name => String(name).endsWith('memory.md')), false, 'the summary was not written into memory.md');
    await app.cdp.screenshot(join(proofDir, 'lot5-3-compacted.png'));
    record('PROOF 5 — real click on ⚡: summary + last exchange on disk, screen = disk, gauge recomputed; the vault key was on the request (Authorization), no tool, no memory.md');

    // ── Proof 6: a real restart keeps the compacted conversation and the settings ────
    const code = await quit(app);
    record(`PROOF 6a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 2`));
    await enter('alpha');
    await waitFor(async () => (await userBubbles()).length === 1, { timeout: 10000 });
    assert.match((await assistantBubbles())[0], /Résumé de contexte compressé/, 'the summary is the first message after the restart');
    await waitFor(async () => (await gaugeLabel()) === expected(await mainOnDisk(), 4000), { timeout: 8000 });
    await waitFor(() => exists('[data-testid="oa-context-bar"]'));
    record('PROOF 6 — after a real restart the compacted conversation and the gauge (max_tokens 4000) come back exactly as saved');

    // ── Proof 7: a failing model leaves the conversation untouched, and the error is in view ──
    const restore = async () => {
      await writeFile(join(alpha, '.openagent', 'conversations.json'), JSON.stringify({
        version: 1,
        branches: [{ id: 'main', label: 'Principale', messages: history(6, 800), created_at: new Date().toISOString() }],
      }));
      await enter('beta');
      await sleep(500);
      await enter('alpha');
      await waitFor(async () => (await userBubbles()).length === 3, { timeout: 10000 });
      await sleep(400);
    };
    await restore();
    const untouched = JSON.stringify(await mainOnDisk());
    state.summary = 'fail';
    await click('#oa-compact-btn');
    await waitFor(() => exists('[data-testid="oa-chat-error"]'), { timeout: 15000 });
    assert.match(await text('[data-testid="oa-chat-error"]'), /Erreur du provider \(500\)/);
    await sleep(300);
    assert.equal(await js(`(() => {
      const banner = document.querySelector('[data-testid="oa-chat-error"]').getBoundingClientRect();
      const view = document.querySelector('[data-testid="oa-chat-scroll"]').getBoundingClientRect();
      return banner.top >= view.top && banner.bottom <= view.bottom;
    })()`), true, 'the error banner is inside the visible area');
    assert.equal(JSON.stringify(await mainOnDisk()), untouched, 'nothing was dropped on disk');
    assert.equal((await userBubbles()).length, 3, 'nor on screen');
    await app.cdp.screenshot(join(proofDir, 'lot5-4-error.png'));
    state.summary = 'ok';
    record('PROOF 7 — model in error (500): the conversation is byte for byte unchanged and the error is visible in the chat');

    // ── Proof 8: automatic compaction after a completed turn, no click ───────────
    await setContextSettings({ auto: true });
    await restore();
    const before = summaries().length;
    await send('suite');
    await waitFor(async () => (await mainOnDisk())[0]?.content.startsWith('**[Résumé de contexte compressé]**'), { timeout: 25000 });
    assert.equal(summaries().length, before + 1, 'exactly one summary for the turn');
    const auto = await mainOnDisk();
    assert.equal(auto.length, 3);
    assert.equal(auto.at(-2).content, 'suite');
    assert.equal(summaries().at(-1).authorization, `Bearer ${KEY}`);
    record('PROOF 8 — auto_compact on: one turn triggered exactly one summary, no click; the message and its reply are kept');

    // The key only lives in the vault: on disk in clear in none of the files we can read.
    for (const file of [join(home, 'folders.json'), join(alpha, '.openagent', 'conversations.json')]) {
      assert.equal((await readFile(file, 'utf8')).includes(KEY), false, `${file} must not contain the API key`);
    }
    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    record('PROOF 9 — the API key appears in no JSON file of the data directory nor in the conversation');

    const code2 = await quit(app);
    record(`PROOF 10 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot5-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the context gauge lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    // What the user would have seen at the moment of failure — a bare "waitFor timed out" says nothing.
    try {
      await app.cdp.screenshot(join(proofDir, 'lot5-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 700))}\n`);
    } catch { /* the page may be gone */ }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await new Promise(resolve => { modelServer.closeAllConnections?.(); modelServer.close(() => resolve()); });
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await Promise.all([home, alpha, beta, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot5: ${error.stack || error}\n`);
  process.exitCode = 1;
});
