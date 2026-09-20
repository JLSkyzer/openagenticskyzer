// Plain Node script. Final end-to-end proof for the conversation-branches lot: spawns the REAL
// packaged executable (real main.cjs, real safeStorage vault, real worker), Python stripped from
// PATH, and drives it over the Chrome DevTools Protocol with REAL mouse events. A local HTTP server
// plays the language model ("réponse N" to the Nth request, or never answering to keep a run
// open). Every claim about the conversation is re-read from .openagent/conversations.json, and the
// app is really quit and relaunched to prove the branches survive a restart.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL4-SECRET';

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

  const home = await mkdtemp(join(tmpdir(), 'openagent-lot4-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-lot4-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-lot4-userdata-'));
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));

  // Fake model: the Nth request answers "réponse N", unless `hang` is set (then it never answers).
  let count = 0;
  let hang = false;
  const hung = [];
  const modelServer = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const n = ++count;
      if (hang) { hung.push(response); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: `réponse ${n}` }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9350;

  // Launches the packaged app and connects to its page over CDP.
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
  // Where the machine's REAL cursor is relative to the app window, and what page element is under it:
  // a real cursor resting over the page can take :hover away from a synthetic (CDP) mouse move.
  async function describeRealCursor() {
    const instance = [...running][0];
    const cursor = await new Promise(resolve => {
      const ps = spawn('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', d => { out += d; });
      ps.on('close', () => resolve(out.trim()));
    });
    const [cx, cy] = cursor.split(',').map(Number);
    // Content origin on screen = window origin + side border, and the rest of the outer height is title bar + one border.
    const view = await instance.cdp.evaluate(`(() => {
      const border = (outerWidth - innerWidth) / 2;
      const x = ${cx} - (screenX + border);
      const y = ${cy} - (screenY + (outerHeight - innerHeight) - border);
      const e = document.elementFromPoint(x, y);
      return { pointInPage: [Math.round(x), Math.round(y)], inside: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight, element: e ? (e.getAttribute('data-testid') || e.tagName) : null };
    })()`);
    return `Real cursor ${cursor} → ${JSON.stringify(view)}`;
  }
  // Closes the app the way a user does (window close → before-quit) and waits for the real exit.
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
  let lastMouse = null;
  try {
    app = await launch();
    record(`PROOF 2 — packaged executable launched directly (pid=${app.child.pid}), no npm start, isolated OPENAGENT_HOME and userData`);

    // The helpers read `app` at call time so they keep working after the relaunch below.
    const js = expression => app.cdp.evaluate(expression);
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const userBubbles = () => texts('[data-testid="oa-user-bubble"]');
    const assistantBubbles = () => texts('[data-testid="oa-assistant-bubble"]');
    const untilIdle = () => waitFor(async () => (await text('#oa-send-btn')) === '➤', { timeout: 30000 });
    const disk = async () => JSON.parse(await readFile(join(project, '.openagent', 'conversations.json'), 'utf8'));
    const branchOf = (doc, id) => doc.branches.find(b => b.id === id);
    const contents = branch => branch.messages.map(m => m.content);
    const send = async message => {
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
      await waitFor(async () => (await userBubbles()).includes(message), { timeout: 8000 });
    };
    const center = selector => js(`(() => {
      const r = document.querySelector(${q(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const mouse = (type, x, y, extra = {}) => { lastMouse = { type, x, y }; return app.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); };

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

    // ── Proof 3: two turns, no fork yet → no selector; ⑂ hidden until a real hover ───
    await send('premier');
    await waitFor(async () => (await assistantBubbles()).length === 1, { timeout: 20000 });
    await send('second');
    await waitFor(async () => (await assistantBubbles()).length === 2, { timeout: 20000 });
    await untilIdle();
    assert.equal(await exists('[data-testid="oa-branch-selector"]'), false, 'no selector while no fork exists');
    assert.equal(await countOf('[data-testid="oa-fork-btn"]'), 2, 'one ⑂ per user message');
    const opacity = () => js(`getComputedStyle(document.querySelector('[data-testid="oa-fork-btn"]').parentElement).opacity`);
    assert.equal(await opacity(), '0', 'the ⑂ row is invisible before any hover');
    record(`INFO — ${await describeRealCursor()}`);
    // A user keeps the mouse over the message until the button shows, so this re-sends the move: the
    // machine's REAL cursor can also be over the window, and a single synthetic move may be overridden
    // by a real one that arrives after it (seen only on the first run after packaging).
    await waitFor(async () => {
      const bubble = await center('[data-testid="oa-user-bubble"]');
      await mouse('mouseMoved', bubble.x, bubble.y);
      await sleep(200);
      return (await opacity()) === '1';
    }, { timeout: 10000, interval: 100 });
    await app.cdp.screenshot(join(proofDir, 'lot4-1-hover.png'));
    record('PROOF 3 — 2 turns on main: no selector, one ⑂ per user message, invisible at rest, revealed by a real mouse hover');

    // ── Proof 4: a real click forks after the first message; main is untouched ───────
    const button = await center('[data-testid="oa-fork-btn"]');
    await mouse('mouseMoved', button.x, button.y);
    await mouse('mousePressed', button.x, button.y, { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', button.x, button.y, { button: 'left', clickCount: 1 });
    await waitFor(() => exists('[data-testid="oa-branch-selector"]'), { timeout: 8000 });
    assert.equal(await text('[data-testid="oa-notice"]'), "Branche 'Branche 1' créée.");
    assert.deepEqual(await userBubbles(), ['premier']);
    assert.deepEqual(await assistantBubbles(), []);
    const forked = await disk();
    const forkId = forked.branches.find(b => b.id !== 'main').id;
    assert.deepEqual(contents(branchOf(forked, 'main')), ['premier', 'réponse 1', 'second', 'réponse 2'], 'main untouched by the fork');
    assert.deepEqual(contents(branchOf(forked, forkId)), ['premier']);
    const mainBefore = JSON.stringify(branchOf(forked, 'main').messages);
    await app.cdp.screenshot(join(proofDir, 'lot4-2-forked.png'));
    record('PROOF 4 — real click on ⑂: selector + notice appear, the view is cut after "premier", conversations.json shows main intact and the new branch');

    // ── Proof 5: a turn on the branch lands in the branch only ──────────────────────
    await send('autre piste');
    await waitFor(async () => (await assistantBubbles()).length === 1, { timeout: 20000 });
    await untilIdle();
    let doc = await disk();
    assert.deepEqual(contents(branchOf(doc, forkId)), ['premier', 'autre piste', 'réponse 3']);
    assert.equal(JSON.stringify(branchOf(doc, 'main').messages), mainBefore, 'main is byte for byte unchanged');
    record('PROOF 5 — a message sent on the branch is saved in the branch; main is byte for byte unchanged');

    // ── Proof 6: Stop on the branch keeps the partial in the branch, still nothing in main
    hang = true;
    await send('à interrompre');
    await waitFor(async () => (await text('#oa-send-btn')) === '■', { timeout: 8000 });
    await waitFor(() => hung.length > 0, { timeout: 8000 });
    assert.equal(await countOf('[data-testid="oa-fork-btn"]'), 0, 'no ⑂ while the run is in flight');
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').disabled`), true, 'the selector is locked during the run');
    await app.cdp.screenshot(join(proofDir, 'lot4-3-running.png'));
    await click('#oa-send-btn');
    await untilIdle();
    hang = false;
    for (const response of hung.splice(0)) response.destroy();
    doc = await disk();
    assert.deepEqual(contents(branchOf(doc, forkId)), ['premier', 'autre piste', 'réponse 3', 'à interrompre'], 'the interrupted message is kept on the branch');
    assert.equal(JSON.stringify(branchOf(doc, 'main').messages), mainBefore, 'a Stop on the branch leaves main untouched');
    record('PROOF 6 — during a run: no ⑂, selector locked; Stop keeps the partial on the branch and main stays byte for byte identical');

    // ── Proof 7: quit the real app, relaunch it: the branch is still there ───────────
    const code = await quit(app);
    record(`PROOF 7a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => exists('[data-testid="oa-folder-entry"]'));
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('[data-testid="oa-branch-selector"]'), { timeout: 10000 });
    assert.deepEqual(await texts('[data-testid="oa-branch-select"] option'), ['🌿 Main', 'Branche 1']);
    assert.equal(await js(`document.querySelector('[data-testid="oa-branch-select"]').value`), 'main', 'a folder always opens on main after a restart');
    assert.deepEqual(await userBubbles(), ['premier', 'second']);
    await setValue('[data-testid="oa-branch-select"]', forkId);
    await waitFor(async () => (await userBubbles()).join('|') === 'premier|autre piste|à interrompre', { timeout: 8000 });
    assert.deepEqual(await assistantBubbles(), ['réponse 3']);
    await app.cdp.screenshot(join(proofDir, 'lot4-4-after-restart.png'));
    record('PROOF 7 — after a real restart the selector lists the branch (opened on main) and switching restores its exact messages');

    // ── Proof 8: the restarted app keeps writing to the branch, not to main ──────────
    await send('reprise');
    await waitFor(async () => (await assistantBubbles()).length === 2, { timeout: 20000 });
    await untilIdle();
    doc = await disk();
    assert.deepEqual(contents(branchOf(doc, forkId)), ['premier', 'autre piste', 'réponse 3', 'à interrompre', 'reprise', 'réponse 5']);
    assert.equal(JSON.stringify(branchOf(doc, 'main').messages), mainBefore, 'main still byte for byte unchanged');
    record('PROOF 8 — after the restart a new message is saved in the branch; main still byte for byte unchanged');

    // ── Proof 9: "Effacer l'historique" drops the forks and hides the selector ───────
    await click('#oa-settings-btn');
    await waitFor(() => exists('[data-testid="oa-settings-tab"][data-tab="danger"]'));
    await click('[data-testid="oa-settings-tab"][data-tab="danger"]');
    await waitFor(() => exists('#oa-danger-clear-btn'));
    await click('#oa-danger-clear-btn');
    await waitFor(() => exists('#oa-confirm-ok-btn'));
    await click('#oa-confirm-ok-btn');
    await waitFor(async () => /Historique effacé/.test(await text('[data-testid="oa-danger-status"]')));
    await click('#oa-settings-close-btn');
    await waitFor(async () => !(await exists('[data-testid="oa-branch-selector"]')), { timeout: 8000 });
    assert.deepEqual(await userBubbles(), []);
    doc = await disk();
    assert.equal(doc.branches.length, 1, 'every fork is gone on disk');
    assert.deepEqual(doc.branches[0].messages, [], 'main is empty on disk');
    await app.cdp.screenshot(join(proofDir, 'lot4-5-cleared.png'));
    record('PROOF 9 — "Effacer l\'historique": selector gone, one empty main branch left on disk');

    // The API key only ever lives in the encrypted vault: it is on disk in clear in neither file.
    const leaked = [join(home, 'folders.json'), join(project, '.openagent', 'conversations.json')];
    for (const file of leaked) assert.equal((await readFile(file, 'utf8')).includes(KEY), false, `${file} must not contain the API key`);
    record('PROOF 10 — the API key appears in neither folders.json nor conversations.json');

    const code2 = await quit(app);
    record(`PROOF 11 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot4-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the branches lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    // What the user would have seen at the moment of failure — a bare "waitFor timed out" says nothing.
    try {
      await app.cdp.screenshot(join(proofDir, 'lot4-failure.png'));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await app.cdp.evaluate('document.body.textContent')).slice(0, 600))}\n`);
      process.stderr.write(`Page state at failure: ${JSON.stringify(await app.cdp.evaluate(`({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        forkRowOpacity: (() => { const b = document.querySelector('[data-testid="oa-fork-btn"]'); return b ? getComputedStyle(b.parentElement).opacity : null; })(),
        hoveredTestId: (() => { const h = [...document.querySelectorAll(':hover')].at(-1); return h ? (h.getAttribute('data-testid') || h.tagName) : null; })(),
        innerSize: [innerWidth, innerHeight],
        firstBubbleRectNow: (() => { const b = document.querySelector('[data-testid="oa-user-bubble"]'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
        elementUnderLastMouse: (() => { const m = ${JSON.stringify(lastMouse)}; if (!m) return null; const e = document.elementFromPoint(m.x, m.y); return e ? (e.getAttribute('data-testid') || e.tagName) : null; })(),
        devicePixelRatio,
      })`))}\n`);
      process.stderr.write(`Last mouse event sent: ${JSON.stringify(lastMouse)}\n`);
      process.stderr.write(`${await describeRealCursor()}\n`);
    } catch { /* the page may be gone */ }
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    for (const response of hung) response.destroy();
    await new Promise(resolve => { modelServer.closeAllConnections?.(); modelServer.close(() => resolve()); });
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await Promise.all([home, project, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot4: ${error.stack || error}\n`);
  process.exitCode = 1;
});
