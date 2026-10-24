// Run with Electron, not node. Proves the local .gguf model selector end to end through the real UI, the REAL
// worker.mjs and the REAL node-llama-cpp engine on a real tiny GGUF (llama.cpp's own CI asset). 'pick-gguf' is
// stubbed to return a real path directly (it is a native file dialog nothing can drive, same as 'open-folder' in
// every other component test) — everything AFTER that point is real: gguf-add, the library list, activation,
// a real agent turn with NO connection configured at all, and the removal that leaves no model active. Nothing here
// opens an external application.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, copyFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng, withTimeout } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 60000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Ends the worker the way main.cjs quits (op shutdown: it waits for its native calls, frees the model, then exits
 * itself). After a reply the worker reads the VRAM in the background (re-placement check), and Worker.terminate()
 * during a native call crashes the whole process (0xC0000409). Every wait here is bounded: 60 s for the worker to end
 * by itself, then terminate() for at most 5 s (it cannot interrupt a thread blocked in a native call either). Resolves
 * null once the thread is gone, or what it was still waiting for (its last 'quit-wait' report). */
async function endWorker(worker) {
  if (worker.threadId === -1) return null;
  let timer;
  let last = null;
  const onReport = message => { if (message?.type === 'quit-wait') last = { at: Date.now(), ...message }; };
  worker.on('message', onReport);
  const exited = new Promise(resolve => worker.once('exit', () => resolve('exited')));
  worker.postMessage({ op: 'shutdown', id: 'test-shutdown' });
  const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 60000); })]);
  clearTimeout(timer);
  worker.off('message', onReport);
  if (outcome === 'exited') return null;
  const detail = last
    ? `last report ${Math.round((Date.now() - last.at) / 1000)} s ago, phase « ${last.phase} », waiting for: ${last.waiting.join(', ') || 'nothing tracked'}`
    : 'no report at all since the shutdown op: its thread is blocked in a synchronous native call';
  process.stderr.write(`note: the worker did not end within 60 s of shutdown (${detail}): terminate() for at most 5 s\n`);
  await withTimeout(worker.terminate(), 5000, 'Worker.terminate()').catch(error => process.stderr.write(`note: ${error.message}\n`));
  return detail;
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-localmodel-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  const modelPath = join(root, 'stories260K.gguf');
  await copyFile(path.join(__dirname, 'fixtures', 'stories260K.gguf'), modelPath);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const screenshotDir = process.env.OPENAGENT_LOCALMODEL_SCREENSHOT_DIR || home;
  const pageMessages = [];
  let win;
  let worker;
  let workerStuck = null;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    let ggufDialogPath = null; // what a real native file picker would have returned
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return alpha;
      if (request.op === 'pick-gguf') return ggufDialogPath;
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id });
      });
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', event => pageMessages.push(`[${event.level}] ${event.message}`));
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    // Bounded: a renderer that never answers fails the run naming the script, instead of hanging until the runner's kill.
    const js = async (code, ms = 15000) => {
      try { return await withTimeout(win.webContents.executeJavaScript(code), ms, 'executeJavaScript'); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const send = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);

    await waitFor(() => exists('[data-testid="oa-folder-entry"]'), { timeout: 15000 });
    await click('[data-testid="oa-folder-entry"]');
    // #oa-model-btn is on the page from the start: wait for the sidebar's active entry, set only once activate_folder
    // has answered — a send before that is dropped by the page (no active folder).
    await waitFor(() => exists('[data-testid="oa-folder-entry"][data-active="true"]'), { timeout: 15000, what: 'folder opened' });
    assert.equal(await exists('#oa-model-btn'), true, 'the model button');

    // ── 1. Open the selector, import a real .gguf through the (stubbed native) picker ─────────────────
    await click('#oa-model-btn');
    // The list block first says « Chargement… » while gguf-list is in flight: wait for the empty library's own text,
    // never for the block (it exists in the loading state too — the 2026-10-24 closure run failed on exactly that).
    await waitFor(async () => /Aucun modèle importé/.test(await text('[data-testid="oa-local-models"]')), { timeout: 15000, what: 'the empty library « Aucun modèle importé »' });
    ggufDialogPath = modelPath;
    await click('#oa-local-model-import-btn');
    await waitFor(async () => (await countOf('[data-testid="oa-local-model-entry"]')) === 1, { what: 'imported entry appears' });
    assert.match(await text('[data-testid="oa-local-model-entry"]'), /stories260K\.gguf/);

    // ── 2. Importing activates it immediately: the banner and the button both say so ────────────────
    await waitFor(async () => /Modèle actif/.test(await text('[data-testid="oa-model-active"]')) && /stories260K\.gguf/.test(await text('[data-testid="oa-model-active"]')), { what: 'active banner shows the local model' });
    assert.match(await text('[data-testid="oa-model-active"]'), /local/);
    assert.equal(await js(`document.querySelector('[data-testid="oa-model-active"]').dataset.state`), 'active');
    // The background estimate starts only while the dialog is open (ruling F3d) and is cancelled when it closes: wait
    // for it here. The chip beside the button is absent until model-status carries a placement — nothing is cached in
    // this fresh home and the model is not loaded yet, so only the finished estimate can make it appear.
    await waitFor(() => exists('[data-testid="oa-model-placement"][data-source="estimate"]'), { timeout: 180000, what: 'the estimated placement beside the button' });
    assert.match(await text('[data-testid="oa-model-placement"]'), / \(estimé\)$/, 'before the load the placement says « (estimé) »');
    assert.match(await text('[data-testid="oa-model-placement-detail"]'), /\(estimé\)/, 'the dialog shows the estimated split and memory');
    assert.match(await text('#oa-model-btn'), /stories260K/, 'the chip sits beside the button, whose text is unchanged');
    await writeFile(join(screenshotDir, 'localmodel-1b-estimate.png'), await capturePng(win));
    await click('#oa-model-close-btn');
    await waitFor(async () => /stories260K/.test(await text('#oa-model-btn')), { what: 'the button label follows' });
    await writeFile(join(screenshotDir, 'localmodel-1-active.png'), await capturePng(win));

    // ── 3. A real turn, on the real engine, with NO remote connection configured at all ──────────────
    // The status line during the real turn. stories260K can load and answer in about a second, faster than a poll, so
    // an observer installed before the send records every state of the line; the record is empty before the send (no
    // run, no line).
    await js(`(() => {
      const seen = window.__oaTurnStatus = [];
      const check = () => {
        const line = document.querySelector('[data-testid="oa-turn-status"]');
        if (!line) return;
        const entry = { phase: line.dataset.phase, label: line.querySelector('[data-testid="oa-turn-label"]')?.textContent ?? '' };
        const last = seen.at(-1);
        if (!last || last.phase !== entry.phase || last.label !== entry.label) seen.push(entry);
      };
      check();
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    })()`);
    assert.deepEqual(await js('window.__oaTurnStatus'), [], 'no status line before the send');
    await send('Once upon a time');
    const MODEL_PHASES = ['loading', 'reading', 'writing'];
    await waitFor(async () => (await js('window.__oaTurnStatus')).some(entry => MODEL_PHASES.includes(entry.phase)), { timeout: 60000, what: 'the status line in loading, reading or writing' });
    const lineLive = await js(`['loading', 'reading', 'writing'].includes(document.querySelector('[data-testid="oa-turn-status"]')?.dataset.phase)`);
    await writeFile(join(screenshotDir, 'localmodel-2a-turn-status.png'), await capturePng(win));
    if (!lineLive) process.stdout.write('note: the turn had left loading/reading/writing before the capture\n');
    await waitFor(async () => (await countOf('[data-testid="oa-assistant-bubble"]')) === 1 && await isIdle(), { timeout: 60000, what: 'real local reply' });
    const statuses = await js('window.__oaTurnStatus');
    for (const entry of statuses.filter(entry => MODEL_PHASES.includes(entry.phase))) {
      assert.match(entry.label, /^(Chargement du modèle…( \d+ %)?|Lecture du message…|Écriture…)$/, `the label of ${entry.phase}: ${JSON.stringify(statuses)}`);
    }
    assert.equal(await exists('[data-testid="oa-turn-status"]'), false, 'the status line is gone once the reply is done');
    process.stdout.write(`Turn status seen: ${statuses.map(entry => entry.label).join(' → ')}\n`);
    assert.ok((await text('[data-testid="oa-assistant-bubble"]')).trim().length > 0, 'the real local model produced real text');
    // Task 6: the timing line under the reply, attached by `done` in the same step that makes the view idle. The first
    // turn loads the model, so all four parts are there. It sits outside the bubble, whose text is the answer alone.
    assert.equal(await countOf('[data-testid="oa-reply-timing"]'), 1, 'one timing line, under the one reply');
    const timingText = await text('[data-testid="oa-reply-timing"]');
    assert.match(timingText, /^1ᵉʳ mot .+ s · total .+ s · .+ tok\/s · chargement .+$/, `the timing line: ${timingText}`);
    assert.equal(await js(`!!document.querySelector('[data-testid="oa-assistant-bubble"] [data-testid="oa-reply-timing"]')`), false, 'the timing line is not inside the bubble');
    // stories260K never reasons: no « Réflexion » block.
    assert.equal(await exists('[data-testid="oa-reasoning"]'), false, 'no reasoning block for a model that does not reason');
    process.stdout.write(`Timing line: ${timingText}\n`);
    await writeFile(join(screenshotDir, 'localmodel-2b-timing.png'), await capturePng(win));
    // After the real load the placement is model.gpuLayers, the truth: no « estimé » any more.
    await waitFor(() => exists('[data-testid="oa-model-placement"][data-source="loaded"]'), { timeout: 30000, what: 'the loaded placement beside the button' });
    assert.doesNotMatch(await text('[data-testid="oa-model-placement"]'), /estimé/, 'the loaded placement is not an estimate');
    await writeFile(join(screenshotDir, 'localmodel-2-replied.png'), await capturePng(win));

    // ── 4. A real click on ✕ removes it from the library (and clears activation if it was active) ────
    await click('#oa-model-btn');
    await waitFor(() => exists('[data-testid="oa-local-model-entry"]'), { timeout: 10000 });
    await click('[data-testid="oa-local-model-remove"]');
    await waitFor(async () => (await countOf('[data-testid="oa-local-model-entry"]')) === 0, { what: 'removed from the library' });
    // The banner follows model-status, a separate request answered after (or before) the list: wait for its state
    // first, never read it the instant the list empties.
    await waitFor(async () => (await js(`document.querySelector('[data-testid="oa-model-active"]').dataset.state`)) === 'none', { what: 'the banner says no model is selected' });
    assert.doesNotMatch(await text('[data-testid="oa-model-active"]'), /stories260K/, 'no longer shown as active once removed');
    assert.equal(await text('[data-testid="oa-model-active"]'), '⚠ Aucun modèle sélectionné — importe un fichier .gguf.');

    process.stdout.write(`PASS local .gguf model: real import (stubbed native picker), immediate activation, a real turn on the real engine with no connection configured, real removal (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'localmodel-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await withTimeout(win.webContents.executeJavaScript('document.body.textContent'), 5000, 'executeJavaScript')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-10))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    // Before the window goes: the worker's last messages are still relayed to a live page.
    if (worker) workerStuck = await endWorker(worker);
    win?.destroy();
    if (!process.env.OPENAGENT_LOCALMODEL_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
  // A worker that does not end is a failure even when every assertion passed.
  if (workerStuck) throw new Error(`the worker did not end within 60 s of the shutdown op (${workerStuck})`);
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL local-model visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
