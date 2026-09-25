// Plain Node script. Final end-to-end proof for the attachments lot: spawns the REAL packaged executable (real
// main.cjs, real safeStorage vault, real worker, the real strict Content-Security-Policy, Python stripped from PATH)
// driven over the Chrome DevTools Protocol. A local HTTP server plays the model and records what it receives. What
// only the packaged app proves: pdf.js and its worker load from inside app.asar under the strict policy and read a
// real PDF, the vault key rides on a request that carries files, the files survive in the saved conversation and a
// REAL restart, and 🔄 sends them again. The native file chooser cannot be driven: real files are handed to the real
// <input type=file> with DOM.setFileInputFiles. Nothing here opens an external application.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL12-SECRET';

function buildPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where screenshots/logs are written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const python = await checkPythonAbsent();
  record(`PROOF 1 — stripped PATH entries: ${JSON.stringify(python.stripped)}; "where python" under the sanitized PATH: exit=${python.whereCode}`);
  assert.notEqual(python.whereCode, 0, 'python must not be resolvable on the PATH used to launch the app');

  const root = await mkdtemp(join(tmpdir(), 'openagent-lot12-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const userData = join(root, 'userdata');
  const files = join(root, 'files');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(userData), mkdir(files)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const paths = { txt: join(files, 'notes.txt'), csv: join(files, 'data.csv'), png: join(files, 'pic.png'), pdf: join(files, 'rapport.pdf'), exe: join(files, 'archive.exe') };
  await writeFile(paths.txt, 'FICHIER-SECRET-42\nligne 2\n');
  await writeFile(paths.csv, 'nom,age\nAda,36\n"Turing, A",41\n');
  await writeFile(paths.png, PNG_1X1);
  await writeFile(paths.pdf, buildPdf(['Bonjour PDF', 'Deuxieme page']));
  await writeFile(paths.exe, 'MZ');

  const requests = [];
  const modelServer = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'vu' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
  const modelPort = modelServer.address().port;
  const userContent = index => [...requests[index].body.messages].reverse().find(m => m.role === 'user').content;

  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const childOutput = [];
  const running = new Set();
  let debugPort = 9880;

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
    const count = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const isIdle = async () => (await text('#oa-send-btn')) === '➤';
    const disk = async () => JSON.parse(await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).branches.find(b => b.id === 'main').messages;
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
    const chooseFiles = async list => {
      const { root: doc } = await app.cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await app.cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#oa-file-input' });
      await app.cdp.send('DOM.setFileInputFiles', { files: list, nodeId });
    };
    const realClick = async selector => {
      const { x, y } = await js(`(() => { const r = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };

    // ── Connect the scripted model (vault) ───────────────────────────────────────
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

    // ── Proof 3: real files, including a real PDF read by pdf.js from inside app.asar, under the strict CSP ─────
    await chooseFiles([paths.txt, paths.csv, paths.png, paths.pdf]);
    await waitFor(async () => (await count('[data-testid="oa-attachment-chip"]')) === 4, { timeout: 30000 });
    await app.cdp.screenshot(join(proofDir, 'lot12-1-chips.png'));
    record('PROOF 3 — packaged: four real files attached through the real file input (text, CSV, image, and a real PDF read by pdf.js and its worker loaded from app.asar under the strict Content-Security-Policy)');

    // ── Proof 4: an unsupported type is refused ──────────────────────────────────
    await chooseFiles([paths.exe]);
    await waitFor(async () => /Format non supporté : archive\.exe/.test(await text('body')), { timeout: 8000 });
    assert.equal(await count('[data-testid="oa-attachment-chip"]'), 4);
    record('PROOF 4 — packaged: archive.exe refused with "Format non supporté", nothing added');

    // ── Proof 5: send — the vault key rides on a request carrying the files ─────────────────────────────────────
    await send('résume');
    await waitFor(async () => (await count('[data-testid="oa-assistant-bubble"]')) === 1 && await isIdle(), { timeout: 30000 });
    assert.equal(requests[0].authorization, `Bearer ${KEY}`);
    const content = userContent(0);
    assert.ok(Array.isArray(content) && content[0].type === 'image_url' && content[0].image_url.url.startsWith('data:image/png;base64,'));
    const textPart = content.find(part => part.type === 'text').text;
    assert.ok(textPart.includes('--- notes.txt ---\nFICHIER-SECRET-42\nligne 2\n\n---'));
    assert.ok(textPart.includes("{'nom': 'Ada', 'age': '36'}"));
    assert.ok(textPart.includes('--- rapport.pdf ---\nBonjour PDF\n\nDeuxieme page\n---'), 'the PDF text reached the model');
    assert.ok(textPart.endsWith('\n\nrésume'));
    assert.equal(JSON.stringify(requests[0].body).includes('"attachments"'), false);
    assert.equal(await count('[data-testid="oa-attachment-chip"]'), 0);
    const saved = (await disk())[0];
    assert.equal(saved.content, 'résume');
    assert.equal(saved.attachments.length, 4);
    record('PROOF 5 — packaged: the model got the image part and a text part with the file, the CSV as Python dicts and the PDF text page by page, the question last, the vault key on the request; the saved message keeps only what was typed plus 4 attachments');

    // ── Proof 6: a real restart shows the conversation with its files, and 🔄 sends them again ───────────────────
    const code = await quit(app);
    record(`PROOF 6a — the app was really quit (exit code ${code})`);
    app = await launch();
    await waitFor(() => app.cdp.evaluate(`!!document.querySelector('[data-testid="oa-folder-entry"]')`), { timeout: 15000 });
    await app.cdp.evaluate(`document.querySelector('[data-testid="oa-folder-entry"]').click()`);
    await waitFor(async () => (await app.cdp.evaluate(`document.querySelectorAll('[data-testid="oa-message-file"]').length`)) === 3, { timeout: 15000 });
    assert.deepEqual(await app.cdp.evaluate(`[...document.querySelectorAll('[data-testid="oa-message-file"]')].map(e => e.textContent)`), ['📄 notes.txt', '📊 data.csv', '📕 rapport.pdf']);
    assert.equal(await app.cdp.evaluate(`document.querySelectorAll('[data-testid="oa-message-image"]').length`), 1);
    await app.cdp.screenshot(join(proofDir, 'lot12-2-after-restart.png'));
    await realClick('[data-testid="oa-regenerate-btn"]');
    await waitFor(async () => requests.length === 2 && await isIdle(), { timeout: 30000 });
    assert.equal(requests[1].authorization, `Bearer ${KEY}`);
    assert.match(JSON.stringify(userContent(1)), /Bonjour PDF/, '🔄 sent the files again');
    assert.equal((await disk()).length, 2, 'the reply was replaced, not appended to');
    record('PROOF 6 — after a real restart the message shows its image and 3 file names from disk; a real click on 🔄 sent the question again with all its files (PDF text included) and replaced the reply');

    for (const name of await readdir(home)) {
      if (name.endsWith('.json')) assert.equal((await readFile(join(home, name), 'utf8')).includes(KEY), false, `${name} must not contain the API key`);
    }
    assert.equal((await readFile(join(alpha, '.openagent', 'conversations.json'), 'utf8')).includes(KEY), false);
    record('PROOF 7 — the API key appears in no data file nor in the conversation (which does hold the attachments)');

    const code2 = await quit(app);
    record(`PROOF 8 — clean exit (exit code ${code2})`);
    await writeFile(join(proofDir, 'lot12-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the attachments lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    try {
      await app.cdp.screenshot(join(proofDir, 'lot12-failure.png'));
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
  process.stderr.write(`FAIL final e2e lot12: ${error.stack || error}\n`);
  process.exitCode = 1;
});
