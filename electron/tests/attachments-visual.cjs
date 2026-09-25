// Run with Electron, not node. Proves file and image attachments end to end through the real UI, the REAL worker.mjs
// and the app's REAL Content-Security-Policy (buildCsp from main.cjs — it decides whether pdf.js can run in the
// page). Files are handed to the real <input type=file> over the DevTools protocol (DOM.setFileInputFiles); the 📎
// button is NOT really clicked (it would open a native dialog nothing can drive) — its wiring is checked with a spy.
// A fake HTTP model records exactly what it is sent. Nothing here opens an external application.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { capturePng } = require('./capture-helper.cjs');
const { buildCsp } = require('../main.cjs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

async function waitFor(fn, { timeout = 15000, interval = 50, what = 'condition' } = {}) {
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

// A real, minimal PDF (one Helvetica line per page, a correct xref table).
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-attach-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  const files = join(root, 'files');
  await Promise.all([mkdir(home), mkdir(alpha), mkdir(beta), mkdir(files)]);
  const screenshotDir = process.env.OPENAGENT_ATTACH_SCREENSHOT_DIR || home;
  const paths = {
    txt: join(files, 'notes.txt'), csv: join(files, 'data.csv'), png: join(files, 'pic.png'), pdf: join(files, 'rapport.pdf'),
    exe: join(files, 'archive.exe'), badPdf: join(files, 'casse.pdf'), big: join(files, 'enorme.txt'),
  };
  await writeFile(paths.txt, 'FICHIER-SECRET-42\nligne 2\n');
  await writeFile(paths.csv, 'nom,age\nAda,36\n"Turing, A",41\n');
  await writeFile(paths.png, PNG_1X1);
  await writeFile(paths.pdf, buildPdf(['Bonjour PDF', 'Deuxieme page']));
  await writeFile(paths.exe, 'MZ');
  await writeFile(paths.badPdf, 'ceci n\'est pas un pdf');
  await writeFile(paths.big, Buffer.alloc(11 * 1024 * 1024, 97));
  const pageMessages = [];
  let win;
  let server;
  let worker;
  try {
    const modelRequests = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        modelRequests.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'vu' }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(true)] } });
    });
    let nextFolder = alpha;
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'open-folder') return nextFolder;
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'm', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const outgoing = request.op === 'send' ? { ...request, payload: { ...request.payload, connection } } : request;
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...outgoing, id });
      });
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', event => pageMessages.push(`[${event.level}] ${event.message}`));
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const countOf = selector => js(`document.querySelectorAll(${q(selector)}).length`);
    const texts = selector => js(`[...document.querySelectorAll(${q(selector)})].map(e => e.textContent)`);
    const isIdle = () => js(`document.getElementById('oa-send-btn')?.textContent === '➤'`);
    const chips = () => js(`[...document.querySelectorAll('[data-testid="oa-attachment-chip"]')].map(e => e.dataset.kind + ':' + (e.querySelector('img')?.title || [...e.querySelectorAll('span')].map(s => s.textContent).join(' ')))`);
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);
    const newestToast = async pattern => {
      await waitFor(async () => pattern.test((await toasts()).at(-1)?.text ?? ''), { what: `toast ${pattern}` });
      return (await toasts()).at(-1);
    };
    const setText = message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const pressEnter = () => js(`document.getElementById('oa-input-ta').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    const userContent = request => [...request.messages].reverse().find(m => m.role === 'user').content;
    const disk = async folder => JSON.parse(await readFile(join(folder, '.openagent', 'conversations.json'), 'utf8')).branches.find(b => b.id === 'main').messages;
    const rectCenter = selector => js(`(() => { const list = document.querySelectorAll(${q(selector)}); const r = list[list.length - 1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const realClick = async selector => {
      const { x, y } = await rectCenter(selector);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    // Hands real files to the real <input type=file>, as a native chooser would.
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const chooseFiles = async list => {
      const { root: doc } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector: '#oa-file-input' });
      await dbg.sendCommand('DOM.setFileInputFiles', { files: list, nodeId });
    };
    const openFolder = async name => {
      nextFolder = name === 'alpha' ? alpha : beta;
      await click('#oa-open-folder-btn');
      await waitFor(() => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].some(e => e.textContent.includes(${JSON.stringify(name)}))`), { what: `folder ${name} listed` });
      await pause(400);
    };

    await openFolder('alpha');

    // ── 1. The 📎 button is wired to the hidden file input (a native chooser cannot be driven: spy instead) ─────
    assert.equal(await js(`document.getElementById('oa-file-input').multiple`), true, 'several files at once');
    const accept = await js(`document.getElementById('oa-file-input').accept`);
    for (const extension of ['.pdf', '.csv', '.png', '.py', '.md']) assert.ok(accept.split(',').includes(extension), extension);
    await js(`window.__clicked = 0; HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.__clicked++; }; true`);
    await click('#oa-attach-btn');
    assert.equal(await js(`window.__clicked`), 1, 'the 📎 button opens the file input');

    // ── 2. Real files through the real input: texts, CSV, image, and a real PDF read by pdf.js in the page ─────
    await chooseFiles([paths.txt, paths.csv, paths.png, paths.pdf]);
    await waitFor(async () => (await countOf('[data-testid="oa-attachment-chip"]')) === 4, { timeout: 30000, what: 'four chips (the PDF is read by pdf.js under the app CSP)' });
    assert.deepEqual(await chips(), ['file:📄 notes.txt', 'file:📊 data.csv', 'image:pic.png', 'file:📕 rapport.pdf']);
    assert.equal((await newestToast(/ajouté/)).text, '📎 rapport.pdf ajouté');
    assert.equal((await newestToast(/ajouté/)).kind, 'positive');
    assert.equal(await js(`Math.round(document.querySelector('[data-kind="image"]').getBoundingClientRect().width)`), 72, 'the thumbnail is 72px');
    assert.equal(await js(`Math.round(document.querySelector('[data-kind="file"]').getBoundingClientRect().width)`), 90, 'a file card is 90px wide');
    await writeFile(join(screenshotDir, 'attach-1-chips.png'), await capturePng(win));

    // ── 3. An unsupported type is refused with a warning; an unreadable PDF is kept, with its error inside ───────
    await chooseFiles([paths.exe]);
    const refused = await newestToast(/Format non supporté/);
    assert.equal(refused.text, 'Format non supporté : archive.exe');
    assert.equal(refused.kind, 'warning');
    assert.equal(await countOf('[data-testid="oa-attachment-chip"]'), 4, 'nothing was added');
    await chooseFiles([paths.badPdf]);
    await waitFor(async () => (await countOf('[data-testid="oa-attachment-chip"]')) === 5, { what: 'the unreadable PDF is still attached' });
    assert.equal((await chips()).at(-1), 'file:📕 casse.pdf');

    // ── 4. A file over the size limit is refused with the reason ───────────────────────────────────────────────
    await chooseFiles([paths.big]);
    const tooBig = await newestToast(/Erreur upload/);
    assert.match(tooBig.text, /enorme\.txt dépasse la limite de 10 Mo/);
    assert.equal(tooBig.kind, 'negative');
    assert.equal(await countOf('[data-testid="oa-attachment-chip"]'), 5);

    // ── 5. A real click on ✕ removes exactly that file ────────────────────────────────────────────────────────
    assert.equal(await countOf('[data-testid="oa-attachment-remove"]'), 5);
    await realClick('[data-testid="oa-attachment-remove"]'); // the last one: casse.pdf
    await waitFor(async () => (await countOf('[data-testid="oa-attachment-chip"]')) === 4, { what: 'chip removed' });
    assert.deepEqual((await chips()).map(c => c.split(':')[1]), ['📄 notes.txt', '📊 data.csv', 'pic.png', '📕 rapport.pdf']);

    // ── 6. Send: the model receives the files, the message shows them, the chips are cleared ──────────────────
    await setText('résume');
    await pressEnter();
    await waitFor(async () => (await countOf('[data-testid="oa-assistant-bubble"]')) === 1 && await isIdle(), { timeout: 30000, what: 'first reply' });
    assert.equal(await countOf('[data-testid="oa-attachment-chip"]'), 0, 'the files left with the message');
    const first = userContent(modelRequests[0]);
    assert.ok(Array.isArray(first), 'an image makes the content a list');
    assert.equal(first[0].type, 'image_url');
    assert.match(first[0].image_url.url, /^data:image\/png;base64,/);
    const textPart = first.find(part => part.type === 'text').text;
    assert.ok(textPart.includes('--- notes.txt ---\nFICHIER-SECRET-42\nligne 2\n\n---'), 'the text file');
    assert.ok(textPart.includes("--- data.csv ---\nCSV (2 lignes preview):\n{'nom': 'Ada', 'age': '36'}\n{'nom': 'Turing, A', 'age': '41'}\n---"), 'the CSV, as Python dicts');
    assert.ok(textPart.includes('--- rapport.pdf ---\nBonjour PDF\n\nDeuxieme page\n---'), 'the PDF text, page by page');
    assert.ok(textPart.endsWith('\n\nrésume'), 'the question comes last');
    assert.equal(JSON.stringify(modelRequests[0]).includes('"attachments"'), false, 'the field itself is never sent');
    assert.equal(await countOf('[data-testid="oa-message-image"]'), 1, 'the bubble shows the image');
    assert.equal(await js(`document.querySelector('[data-testid="oa-message-image"]').style.maxWidth`), '220px');
    assert.deepEqual(await texts('[data-testid="oa-message-file"]'), ['📄 notes.txt', '📊 data.csv', '📕 rapport.pdf']);
    assert.deepEqual(await texts('[data-testid="oa-user-bubble"]'), ['résume'], 'the bubble text is only what was typed');
    await js(`document.querySelector('[data-testid="oa-chat-scroll"]').scrollTop = 0`);
    // The right-aligned user bubble sits under the toast stack (top right): wait for the toasts to go before the picture.
    await waitFor(async () => (await toasts()).length === 0, { timeout: 10000, what: 'toasts gone' });
    await writeFile(join(screenshotDir, 'attach-2-sent.png'), await capturePng(win));
    const saved = (await disk(alpha))[0];
    assert.equal(saved.content, 'résume');
    assert.equal(saved.attachments.length, 4);

    // ── 7. A later turn still shows the model the files ───────────────────────────────────────────────────────
    await setText('et ensuite ?');
    await pressEnter();
    await waitFor(async () => (await countOf('[data-testid="oa-assistant-bubble"]')) === 2 && await isIdle(), { timeout: 30000, what: 'second reply' });
    assert.match(JSON.stringify(modelRequests[1]), /FICHIER-SECRET-42/, 'the file is still there on the second turn');

    // ── 8. Reopening the conversation from disk shows the same message with its files ─────────────────────────
    await openFolder('beta');
    await openFolder('alpha');
    await waitFor(async () => (await countOf('[data-testid="oa-message-image"]')) === 1, { what: 'attachments shown after a reload from disk' });
    assert.deepEqual(await texts('[data-testid="oa-message-file"]'), ['📄 notes.txt', '📊 data.csv', '📕 rapport.pdf']);

    // ── 9. 🔄 sends the last message again WITH its files (checked in another project, whose last message has some) ──
    await openFolder('beta');
    await chooseFiles([paths.txt]);
    await waitFor(async () => (await countOf('[data-testid="oa-attachment-chip"]')) === 1, { what: 'file attached in beta' });
    await setText('lis ce fichier');
    await pressEnter();
    await waitFor(async () => (await countOf('[data-testid="oa-assistant-bubble"]')) === 1 && await isIdle(), { timeout: 30000, what: 'reply in beta' });
    assert.equal(modelRequests.length, 3);
    await click('[data-testid="oa-regenerate-btn"]');
    await waitFor(async () => modelRequests.length === 4 && await isIdle(), { timeout: 30000, what: 'regenerated' });
    assert.equal(userContent(modelRequests[3]), '--- notes.txt ---\nFICHIER-SECRET-42\nligne 2\n\n---\n\nlis ce fichier', '🔄 asked the same question, files included');
    const regenerated = await disk(beta);
    assert.equal(regenerated.length, 2, 'the reply was replaced, not appended to');
    assert.equal(regenerated[0].attachments.length, 1, 'and the message kept its file');

    // ── 10. ✏️ on that message brings the text AND the file back into the box ──────────────────────────────────
    await js(`document.querySelectorAll('[data-testid="oa-edit-btn"]')[0].click()`);
    await waitFor(async () => (await js(`document.getElementById('oa-input-ta').value`)) === 'lis ce fichier' && (await countOf('[data-testid="oa-attachment-chip"]')) === 1, { what: 'text and file restored' });
    assert.deepEqual(await chips(), ['file:📄 notes.txt']);
    await setText('lis ce fichier autrement');
    await pressEnter();
    await waitFor(async () => modelRequests.length === 5 && await isIdle(), { timeout: 30000, what: 'edited message resent' });
    assert.match(userContent(modelRequests[4]), /FICHIER-SECRET-42[\s\S]*lis ce fichier autrement$/, 'the edited message carries its file');
    assert.equal((await disk(beta)).length, 2, 'the conversation was cut and replaced, not appended to');

    // ── 11. Paste: a file from the clipboard is attached, plain text is left alone ────────────────────────────────
    const pasted = await js(`(() => {
      const box = document.getElementById('oa-input-ta');
      const withFile = new DataTransfer();
      withFile.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'presse-papiers.png', { type: 'image/png' }));
      const filePaste = new ClipboardEvent('paste', { clipboardData: withFile, bubbles: true, cancelable: true });
      box.dispatchEvent(filePaste);
      const onlyText = new DataTransfer();
      onlyText.setData('text/plain', 'du texte');
      const textPaste = new ClipboardEvent('paste', { clipboardData: onlyText, bubbles: true, cancelable: true });
      box.dispatchEvent(textPaste);
      return { fileHandled: filePaste.defaultPrevented, textHandled: textPaste.defaultPrevented };
    })()`);
    assert.deepEqual(pasted, { fileHandled: true, textHandled: false }, 'a pasted file is taken; pasted text is left to the box');
    await waitFor(async () => (await chips()).includes('image:presse-papiers.png'), { what: 'pasted image attached' });

    // ── 12. Drop: highlighted over the zone, attached on drop; a drop elsewhere does nothing (and does not navigate) ──
    const dropped = await js(`(() => {
      const zone = document.querySelector('[data-testid="oa-input-col"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x = 1'], 'depose.py', { type: 'text/x-python' }));
      const over = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
      zone.dispatchEvent(over);
      return new Promise(resolve => setTimeout(() => {
        const highlighted = zone.dataset.dragging === 'true'; // React renders the highlight a moment after the event
        const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
        zone.dispatchEvent(drop);
        resolve({ overHandled: over.defaultPrevented, highlighted, dropHandled: drop.defaultPrevented });
      }, 50));
    })()`);
    assert.deepEqual(dropped, { overHandled: true, highlighted: true, dropHandled: true });
    await waitFor(async () => (await chips()).includes('file:🐍 depose.py'), { what: 'dropped file attached' });
    assert.equal(await js(`document.querySelector('[data-testid="oa-input-col"]').dataset.dragging`), undefined, 'the highlight is gone after the drop');
    const before = await countOf('[data-testid="oa-attachment-chip"]');
    const elsewhere = await js(`(() => {
      const target = document.querySelector('[data-testid="oa-chat-scroll"]') || document.body;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['y'], 'ailleurs.py'));
      const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(drop);
      return { prevented: drop.defaultPrevented, url: location.protocol };
    })()`);
    assert.equal(elsewhere.prevented, true, 'a stray drop is swallowed: the window would otherwise navigate to the file');
    assert.equal(elsewhere.url, 'file:', 'the app is still loaded');
    await pause(300);
    assert.equal(await countOf('[data-testid="oa-attachment-chip"]'), before, 'and nothing was attached by it');
    await writeFile(join(screenshotDir, 'attach-3-paste-drop.png'), await capturePng(win));

    process.stdout.write(`PASS attachments: real files through the real input (text, CSV, image, real PDF read by pdf.js under the app CSP), refusals, ✕, model receives the expanded message, later turns keep the files, reload shows them, ✏️/🔄 keep them, paste, drop (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'attach-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageMessages.slice(-10))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    server?.closeAllConnections?.();
    server?.close();
    if (!process.env.OPENAGENT_ATTACH_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL attachments visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
