// Plain Node script. Final end-to-end proof for the onboarding wizard lot: spawns the REAL packaged executable
// (real main.cjs, real worker, Python stripped from PATH) on a FRESH data directory and WITHOUT the test-only skip,
// driven over the Chrome DevTools Protocol with REAL mouse and keyboard events. What only the packaged app proves:
// the wizard shows on a real first launch and covers the interface, a real Escape does not dismiss it, the model
// selector it opens sits above it, quitting before the end saves nothing (a REAL restart brings it back), and
// finishing is written to disk so a second REAL restart no longer shows it. "Ouvrir un dossier" is not clicked:
// that is a native system dialog nothing can drive. Nothing here opens an external application.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');
// The helper above sets the skip for every other test; this one proves the wizard itself.
delete process.env.OPENAGENT_SKIP_ONBOARDING;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot11-'));
  const home = join(root, 'home');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(userData)]);
  const config = async () => { try { return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); } catch { return {}; } };

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9780;

  async function launch() {
    const port = debugPort++;
    assert.equal(process.env.OPENAGENT_SKIP_ONBOARDING, undefined, 'launched without the skip');
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
    record(`PROOF 2 — packaged executable launched directly (pid=${app.child.pid}) on a FRESH data directory, no skip, no npm start`);

    const js = expression => app.cdp.evaluate(expression);
    const q = selector => JSON.stringify(selector);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const step = () => js(`document.querySelector('[data-testid="oa-onboarding"]')?.dataset.step || null`);
    const center = selector => js(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const realClick = async selector => {
      const { x, y } = await center(selector);
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const escape = async () => {
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    };
    const isOnTop = async selector => { const { x, y } = await center(selector); return js(`!!document.elementFromPoint(${x}, ${y})?.closest('[data-testid="oa-modal-backdrop"]')`); };

    // ── Proof 3: a real first launch shows the wizard, on top, and Escape does not dismiss it ─────────────────
    await waitFor(() => exists('[data-testid="oa-onboarding"]'), { timeout: 15000 });
    assert.equal(await step(), 'welcome');
    assert.equal(await isOnTop('#oa-send-btn'), true, 'the wizard covers the interface');
    await escape();
    await sleep(400);
    assert.equal(await exists('[data-testid="oa-onboarding"]'), true, 'a real Escape did not dismiss it');
    await app.cdp.screenshot(join(proofDir, 'lot11-1-welcome.png'));
    record('PROOF 3 — packaged, real first launch: the wizard covers the interface (checked at the send button) and a real Escape key does not dismiss it');

    // ── Proof 4: real clicks; the real model selector opens above the wizard ─────────────────────────────────────
    await realClick('#oa-onboarding-start');
    await waitFor(async () => (await step()) === 'model');
    await realClick('#oa-onboarding-model-open');
    await waitFor(() => exists('[data-testid="oa-model-active"]'), { timeout: 8000 });
    const dialog = await center('[data-testid="oa-model-active"]');
    assert.equal(await js(`!document.elementFromPoint(${dialog.x}, ${dialog.y})?.closest('[data-testid="oa-onboarding"]')`), true, 'the selector is above the wizard');
    await app.cdp.screenshot(join(proofDir, 'lot11-2-model-above.png'));
    await escape();
    await waitFor(async () => !(await exists('[data-testid="oa-model-active"]')));
    assert.equal(await step(), 'model', 'the wizard is still on its step');
    record('PROOF 4 — real clicks: "Ouvrir les paramètres du modèle" opened the real selector ABOVE the wizard; Escape closed only the selector');

    // ── Proof 5: quitting before the end saves nothing; a REAL restart brings the wizard back ──────────────────
    await realClick('#oa-onboarding-next');
    await waitFor(async () => (await step()) === 'folder');
    assert.equal((await text('#oa-onboarding-next')).trim(), 'Passer', 'no folder open: "Passer"');
    assert.notEqual((await config()).onboarding_done, true);
    const code1 = await quit(app);
    record(`PROOF 5a — quit at step 3 (exit code ${code1}); config.json says onboarding_done=${JSON.stringify((await config()).onboarding_done)} (not true)`);
    app = await launch();
    await waitFor(() => app.cdp.evaluate(`!!document.querySelector('[data-testid="oa-onboarding"]')`), { timeout: 15000 });
    assert.equal(await step(), 'welcome');
    record('PROOF 5 — after a real restart the wizard is back at step 1: nothing was saved before the end');

    // ── Proof 6: the last screen, then finishing writes to disk ────────────────────────────────────────────────
    await realClick('#oa-onboarding-start');
    await waitFor(async () => (await step()) === 'model');
    await realClick('#oa-onboarding-next');
    await waitFor(async () => (await step()) === 'folder');
    await realClick('#oa-onboarding-next'); // "Passer"
    await waitFor(async () => (await step()) === 'done');
    const shortcuts = await js(`[...document.querySelectorAll('[data-testid="oa-onboarding-shortcuts"] > div')].map(e => e.textContent)`);
    assert.deepEqual(shortcuts, ['Ctrl+K — Palette de commandes', 'Entrée — Envoyer le message', 'Shift+Entrée — Nouvelle ligne']);
    await app.cdp.screenshot(join(proofDir, 'lot11-3-done.png'));
    await realClick('#oa-onboarding-finish');
    await waitFor(async () => !(await exists('[data-testid="oa-onboarding"]')), { timeout: 8000 });
    assert.equal((await config()).onboarding_done, true, 'the packaged worker wrote onboarding_done to config.json');
    assert.equal(await isOnTop('#oa-send-btn'), false, 'the interface is usable again');
    record('PROOF 6 — "Passer" past the folder step, only the 3 real shortcuts shown, real click on "Commencer à coder": config.json now says onboarding_done=true and the interface is free');

    // ── Proof 7: a second REAL restart no longer shows it ──────────────────────────────────────────────────────
    const code2 = await quit(app);
    record(`PROOF 7a — quit after finishing (exit code ${code2})`);
    app = await launch();
    await waitFor(() => app.cdp.evaluate(`!!document.getElementById('oa-input-ta')`), { timeout: 15000 });
    await sleep(800);
    assert.equal(await app.cdp.evaluate(`!!document.querySelector('[data-testid="oa-onboarding"]')`), false, 'the wizard did not come back');
    record('PROOF 7 — after a second real restart the wizard no longer appears');

    const code3 = await quit(app);
    record(`PROOF 8 — clean exit (exit code ${code3})`);
    await writeFile(join(proofDir, 'lot11-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the onboarding wizard lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot11-failure.png'));
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
  process.stderr.write(`FAIL final e2e lot11: ${error.stack || error}\n`);
  process.exitCode = 1;
});
