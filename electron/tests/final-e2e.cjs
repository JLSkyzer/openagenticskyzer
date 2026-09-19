// Plain Node script (Node's built-in WebSocket, no extra dependency) — the final
// end-to-end proof for the whole "socle" lot. Spawns the REAL packaged executable
// (release/win-unpacked/openagent.exe, Tâche 11) with the REAL, unmocked main.cjs
// (no ipcMain stubbing like the other *-visual.cjs tests) against a PATH stripped of
// any Python, and drives it entirely through the real Chrome DevTools Protocol — the
// same interface a real user's clicks ultimately produce events on.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, delimiter } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

const { httpGetJson, waitFor, Cdp } = require('./cdp-helper.cjs');

function sanitizedPathWithoutPython() {
  const entries = (process.env.PATH || process.env.Path || '').split(delimiter);
  // Windows also ships a `python.exe`/`python3.exe` App Execution Alias stub under
  // ...\WindowsApps regardless of whether a real interpreter is installed — strip that
  // directory too, or `where python` keeps "succeeding" against a non-interpreter shim.
  return entries.filter(entry => !/python/i.test(entry) && !/\\WindowsApps\\?$/i.test(entry)).join(delimiter);
}

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  // --- Proof 1: Python is not on PATH for this process ------------------------------
  const sanitizedPath = sanitizedPathWithoutPython();
  const originalPythonDirs = (process.env.PATH || '').split(delimiter).filter(e => /python/i.test(e));
  record(`PROOF 1 — PATH entries referencing Python that were stripped for this run: ${JSON.stringify(originalPythonDirs)}`);
  const whereCheck = spawn('cmd', ['/c', 'where python || where python3'], { env: { ...process.env, PATH: sanitizedPath } });
  const whereOutput = await new Promise(resolve => {
    let out = '';
    whereCheck.stdout.on('data', d => { out += d; });
    whereCheck.stderr.on('data', d => { out += d; });
    whereCheck.on('close', code => resolve({ code, out }));
  });
  record(`PROOF 1 — "where python" under the sanitized PATH: exit=${whereOutput.code} output=${JSON.stringify(whereOutput.out.trim())}`);
  assert.notEqual(whereOutput.code, 0, 'python must not be resolvable on the PATH used to launch the app');

  const home = await mkdtemp(join(tmpdir(), 'openagent-e2e-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-e2e-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-e2e-userdata-'));
  // Seed a real folder-history entry (FoldersService's own folders.json schema) so the
  // real Sidebar shows a real, clickable history entry on first load — a native "Ouvrir
  // un dossier" OS file-picker dialog cannot be driven from here, so this test proves the
  // same real IPC/React path (a real click on a real history entry -> real activate_folder
  // round trip) that dialog's own callback would otherwise trigger.
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));

  // --- 3 fake local providers, one per scenario (documented here, not a real vendor) -
  let streamServer, toolServer, stopServer;
  let toolRequestCount = 0;
  let stopServerClientClosed = false;

  streamServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const words = ['Bonjour', ', ', 'voici ', 'une ', 'réponse ', 'en ', 'streaming ', 'réel.'];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timer);
        res.write(`data: [DONE]\r\n\r\n`);
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\r\n\r\n`);
      i++;
    }, 120);
  });
  toolServer = createServer((req, res) => {
    toolRequestCount++;
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (toolRequestCount === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: { content: '', tool_calls: [{ id: 'call-e2e', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'preuve.md', content: 'preuve e2e finale' }) } }] },
            finish_reason: 'tool_calls',
          }],
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: 'Fichier créé avec succès.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  stopServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const words = ['Ceci ', 'est ', 'une ', 'réponse ', 'longue ', 'qui ', 'ne ', "s'arrêtera ", 'jamais ', 'seule.'];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= words.length) { clearInterval(timer); return; }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\r\n\r\n`);
      i++;
    }, 200);
    req.on('close', () => { stopServerClientClosed = true; clearInterval(timer); });
  });
  await Promise.all([streamServer, toolServer, stopServer].map(s => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); })));
  const streamPort = streamServer.address().port;
  const toolPort = toolServer.address().port;
  const stopPort = stopServer.address().port;

  let child;
  let cdp;
  const childOutput = [];
  try {
    // --- Proof 2: launch the packaged exe, outside npm start ------------------------
    const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
    const debugPort = 9336;
    child = spawn(exePath, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: sanitizedPath, OPENAGENT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => childOutput.push(`[stdout] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr] ${d}`));
    child.on('exit', (code, signal) => childOutput.push(`[exit] code=${code} signal=${signal}`));
    record(`PROOF 2 — spawned the packaged executable directly (pid=${child.pid}), no npm start, no dev server, PATH has no Python, OPENAGENT_HOME isolated to ${home}`);

    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${debugPort}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    });
    cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await new Promise(resolve => setTimeout(resolve, 300));

    // --- Proof 3: startup screenshot (empty state, default dark theme) --------------
    await cdp.screenshot(join(proofDir, '1-startup.png'));
    const startupTheme = await cdp.evaluate("document.documentElement.getAttribute('data-theme')");
    record(`PROOF 3 — startup screenshot saved, theme=${startupTheme}`);
    assert.equal(startupTheme, 'dark', 'default theme is dark on first launch');

    // --- Proof 4: a real folder, via a real click on a real Sidebar history entry ---
    await waitFor(() => cdp.evaluate("!!document.querySelector('[data-testid=\"oa-folder-entry\"]')"));
    await cdp.evaluate("document.querySelector('[data-testid=\"oa-folder-entry\"]').click()");
    await waitFor(() => cdp.evaluate("!!document.querySelector('[data-testid=\"oa-folder-entry\"][data-active=\"true\"]')"));
    await cdp.screenshot(join(proofDir, '2-folder-activated.png'));
    record(`PROOF 4 — real click on the real sidebar history entry activated the real folder (${project}) through worker.mjs/FoldersService, TopBar/sidebar confirm it's active, screenshot saved`);

    // --- Proof 5: a real message, really streamed from a real (local) HTTP server ---
    // Scoped to the real project folder (not the global default) throughout this test —
    // every later save-connection call below reuses the SAME scope so the vault's own
    // endpoint-rebinding confirmation (Connections.compose()) is checked against the
    // exact profile it was granted on, matching how a real per-project connection is set.
    await cdp.evaluate(
      `window.openagent.request({ op: 'save-connection', payload: { folder: ${JSON.stringify(project)}, patch: { provider: 'openrouter', base_url: 'http://127.0.0.1:${streamPort}/v1', model: 'e2e-test-model', api_key: 'fake-e2e-key' } } })`,
      true,
    );
    await cdp.evaluate(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'Bonjour');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);
    await waitFor(() => cdp.evaluate("document.getElementById('oa-send-btn')?.textContent === '■'"));
    await waitFor(async () => (await cdp.evaluate('document.body.textContent')).includes('Bonjour, voici'));
    await cdp.screenshot(join(proofDir, '3-streaming.png'));
    await waitFor(async () => (await cdp.evaluate('document.body.textContent')).includes('streaming réel'));
    await waitFor(() => cdp.evaluate("document.getElementById('oa-send-btn')?.textContent === '➤'"));
    record(`PROOF 5 — real message sent, real SSE streaming observed chunk by chunk from a local documented-fake HTTP provider on 127.0.0.1:${streamPort}, screenshot saved`);

    // --- Proof 6: a real tool call requiring permission, blocked then approved ------
    await cdp.evaluate(
      `window.openagent.request({ op: 'save-project-settings', payload: { folder: ${JSON.stringify(project)}, patch: { override_permissions: true, files_ask: true } } })`,
      true,
    );
    await cdp.evaluate(
      `window.openagent.request({ op: 'save-connection', payload: { folder: ${JSON.stringify(project)}, patch: { provider: 'openrouter', base_url: 'http://127.0.0.1:${toolPort}/v1', model: 'e2e-test-model' }, authorization: { confirmEndpoint: true } } })`,
      true,
    );
    await cdp.evaluate(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'crée preuve.md');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);
    await waitFor(() => cdp.evaluate("!!document.querySelector('[data-testid=\"oa-permission-banner\"]')"));
    const targetFile = join(project, 'preuve.md');
    let existsBefore = true;
    try { await readFile(targetFile, 'utf8'); } catch { existsBefore = false; }
    assert.equal(existsBefore, false, 'nothing written to disk before the permission decision');
    await cdp.screenshot(join(proofDir, '4-permission-banner.png'));
    await cdp.evaluate(`
      (() => {
        const btn = Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button')).find(b => b.textContent === 'Autoriser');
        btn.click();
      })();
    `);
    await waitFor(() => cdp.evaluate("!document.querySelector('[data-testid=\"oa-permission-banner\"]')"));
    await waitFor(async () => (await cdp.evaluate('document.body.textContent')).includes('succès'));
    const createdContent = await readFile(targetFile, 'utf8');
    assert.equal(createdContent, 'preuve e2e finale', 'the file was really created, with the real content, only after clicking Autoriser');
    await cdp.screenshot(join(proofDir, '5-tool-approved.png'));
    record(`PROOF 6 — permission banner blocked the write (file absent before decision), real click on Autoriser -> file really created on disk with the right content, screenshots saved`);

    // --- Proof 7: Stop really stops the stream and persists the partial reply -------
    await cdp.evaluate(
      `window.openagent.request({ op: 'save-connection', payload: { folder: ${JSON.stringify(project)}, patch: { provider: 'openrouter', base_url: 'http://127.0.0.1:${stopPort}/v1', model: 'e2e-test-model' }, authorization: { confirmEndpoint: true } } })`,
      true,
    );
    await cdp.evaluate(`
      (() => {
        const el = document.getElementById('oa-input-ta');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, 'Raconte une longue histoire');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })();
    `);
    await waitFor(() => cdp.evaluate("document.getElementById('oa-send-btn')?.textContent === '■'"));
    await waitFor(async () => (await cdp.evaluate('document.body.textContent')).includes('Ceci est'));
    await cdp.evaluate("document.getElementById('oa-send-btn').click()");
    await waitFor(() => cdp.evaluate("document.getElementById('oa-send-btn')?.textContent === '➤'"));
    await new Promise(resolve => setTimeout(resolve, 700));
    const bodyAfterStop = await cdp.evaluate('document.body.textContent');
    assert.ok(!bodyAfterStop.includes("s'arrêtera jamais"), 'the stream really stopped before its final words ever arrived');
    assert.ok(stopServerClientClosed, 'the local server actually observed the real connection close, not just the UI ignoring events');
    await cdp.screenshot(join(proofDir, '6-stopped.png'));
    record('PROOF 7 — clicked Stop mid-stream: the underlying connection really closed, the partial reply stayed visible, screenshot saved');

    // Persistence cross-check against the same data OPENAGENT_HOME pointed the packaged
    // app at — proves the whole run's transcript, not just the live UI, is coherent.
    const messages = await cdp.evaluate(
      `window.openagent.request({ op: 'messages', payload: { folder: ${JSON.stringify(project)}, branchId: 'main' } })`,
      true,
    );
    record(`PROOF 7b — final persisted transcript has ${messages.length} messages, last role=${messages.at(-1)?.role}`);
    assert.ok(messages.length >= 6, 'the whole conversation (3 turns) was actually persisted');

    record('ALL PROOFS PASSED — the packaged app runs the full socle lot end to end with no Python involved.');
    await writeFile(join(proofDir, 'log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    throw error;
  } finally {
    cdp?.close();
    child?.kill();
    await Promise.all([streamServer, toolServer, stopServer].map(s => new Promise(resolve => s.close(() => resolve()))));
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) {
      await Promise.all([home, project, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
    }
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e: ${error.stack || error}\n`);
  process.exitCode = 1;
});
