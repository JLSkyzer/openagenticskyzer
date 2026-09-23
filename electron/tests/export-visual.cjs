// Run with Electron, not node. Proves conversation export end to end through the real UI and the REAL
// worker.mjs: a real click on TopBar's ⬇ button shows "Depuis : <branche>" and the 3 formats, choosing
// one writes a real Markdown/HTML/JSON file on disk (headers, real tool tags via a genuine
// create_file/run_command conversation, multiline tool content quoted, code escaped once) and shows
// "Exporté : <filename>", the same flow works from the command palette (Ctrl+K → Exporter), a write
// failure is refused by the real worker, and the backdrop closes the dropdown without exporting.
// 'open-export' is stubbed here like every other native-OS operation in a per-component visual test
// (open-folder, connection-snapshot): main.cjs's real shell.openPath is only reachable from the
// packaged app, proven for real in final-e2e-lot8.cjs (Tâche 53).
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-export-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
  const screenshotDir = process.env.OPENAGENT_EXPORT_SCREENSHOT_DIR || home;
  let win;
  let worker;
  // Declared here, not inside the try block below: a `const` scoped to `try {}` is invisible from
  // the sibling `catch {}` (block scoping) — referencing it there throws ReferenceError, which a
  // bare `catch {}` with no parameter would then swallow, hiding the REAL failure behind a useless
  // "page text at failure" and nothing else. Cost real debugging time to find; see tasks/lessons.md.
  const pageErrors = [];
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
    });
    const opened = []; // records what the renderer asked to open, instead of really launching an app
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'connection-snapshot') {
        return { provider: 'openrouter', model: 'gpt-4o-mini', base_url: 'https://openrouter.ai/api/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      if (request.op === 'open-export') { opened.push(request.payload); return { opened: true }; }
      return callWorker(request.op, request.payload);
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', event => pageErrors.push(`[${event.level}] ${event.message}`));
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(400);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const toasts = () => js(`[...document.querySelectorAll('[data-testid="oa-toast"]')].map(e => ({ text: e.textContent, kind: e.dataset.kind }))`);
    // Toasts are appended, so the newest is always last (pushToast: [...list, toast].slice(-MAX)) —
    // waiting for the LAST one to match avoids ever touching React-owned DOM from the test (removing
    // a toast node by hand made React's own next reconciliation crash with "removeChild": the node it
    // expected to remove was already gone — a real bug in an earlier draft of this test, not the app).
    const waitForNewestToast = async pattern => {
      await waitFor(async () => pattern.test((await toasts()).at(-1)?.text ?? ''), { timeout: 8000, what: `toast matching ${pattern}` });
      return (await toasts()).at(-1);
    };
    const mouseClick = (x, y) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    const key = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };

    await waitFor(() => exists('[data-testid="oa-folder-entry"]'), { what: 'folder listed' });
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-export-btn'), { what: 'export button' });

    // ── 1. A conversation with tool calls of DIFFERENT real categories (read AND write), so a tag
    // that collapsed to a single default (a real mutation caught while writing this test) would show ──
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    await callWorker('save-messages', {
      folder: alpha, branchId: 'main',
      messages: [
        { role: 'user', content: 'liste les fichiers' },
        { role: 'assistant', content: '', tool_calls: [call('c1', 'list_dir', { path: '.' })] },
        { role: 'tool', tool_call_id: 'c1', content: 'a.py\nb.py\n\nsubdir/\n  c.py' },
        { role: 'assistant', content: '', tool_calls: [call('c2', 'create_file', { path: 'notes.txt', content: 'x' })] },
        { role: 'tool', tool_call_id: 'c2', content: 'Fichier créé.' },
        { role: 'assistant', content: 'Voici avec du code :\n\n```python\nx = "<b>"\n```\n' },
      ],
    });
    await click('[data-testid="oa-folder-entry"]'); // reload the view with the seeded history
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-user-bubble"]').length`)) === 1, { timeout: 8000, what: 'seeded conversation shown' });

    // ── 2. Real click on ⬇: "Depuis : <branche>" + 3 formats ─────────────────────
    await click('#oa-export-btn');
    await waitFor(() => exists('[data-testid="oa-export-menu"]'), { what: 'export menu opens' });
    assert.match(await text('[data-testid="oa-export-menu"]'), /Depuis : 🌿 Main/);
    assert.match(await text('[data-testid="oa-export-menu"]'), /Markdown \(\.md\)/);
    assert.match(await text('[data-testid="oa-export-menu"]'), /HTML \(\.html\)/);
    assert.match(await text('[data-testid="oa-export-menu"]'), /JSON \(\.json\)/);
    await writeFile(join(screenshotDir, 'export-1-menu.png'), await capturePng(win));

    // ── 3. Markdown export: real file, real header, real tags, quoting, toast ────
    await click('#oa-export-md');
    const mdToast = await waitForNewestToast(/^Exporté : conversation_\d{8}_\d{6}\.md$/);
    assert.equal(mdToast.kind, 'positive');
    const mdName = mdToast.text.replace('Exporté : ', '');
    assert.deepEqual(opened.at(-1), { folder: alpha, filename: mdName }, 'main.cjs was asked to open exactly the file that was written');
    const md = await readFile(join(alpha, mdName), 'utf8');
    assert.match(md, /^# Conversation — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
    assert.match(md, new RegExp(`Dossier : \`${alpha.replace(/\\/g, '\\\\')}\``));
    assert.match(md, /Modèle : `gpt-4o-mini` \(openrouter\)/);
    assert.match(md, /\*\*\[READ\]\*\* `list_dir` —/);
    const block = md.split('---\n', 2)[1];
    assert.match(block, /> a\.py\n> b\.py\n> \n> subdir\/\n>   c\.py/, 'every line of the multiline tool content is quoted, blank line included');
    await writeFile(join(screenshotDir, 'export-2-markdown.png'), await capturePng(win));

    // ── 4. HTML export: valid page, code escaped exactly once ────────────────────
    await click('#oa-export-btn');
    await click('#oa-export-html');
    const htmlToast = await waitForNewestToast(/\.html$/);
    const htmlName = htmlToast.text.replace('Exporté : ', '');
    const html = await readFile(join(alpha, htmlName), 'utf8');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<pre><code class='language-python'>x = &quot;&lt;b&gt;&quot;\n<\/code><\/pre>/);
    assert.equal(html.includes('&amp;lt;'), false, 'no double escaping');

    // ── 5. JSON export: one object per entry, real tool_tag ──────────────────────
    await click('#oa-export-btn');
    await click('#oa-export-json');
    const jsonToast = await waitForNewestToast(/\.json$/);
    const jsonName = jsonToast.text.replace('Exporté : ', '');
    const data = JSON.parse(await readFile(join(alpha, jsonName), 'utf8'));
    const readEntry = data.find(e => e.tool_name === 'list_dir');
    assert.equal(readEntry.tool_tag, 'read', 'the real registered category of list_dir, not a guess');
    const writeEntry = data.find(e => e.tool_name === 'create_file');
    assert.equal(writeEntry.tool_tag, 'write', "a DIFFERENT tag from list_dir's: proves the tag reflects each tool's own real category, not one collapsed default");

    // ── 6. Same flow from the command palette (Ctrl+K → Exporter) ────────────────
    await js(`document.getElementById('oa-input-ta').focus()`);
    key('K', ['control']);
    await waitFor(() => exists('[data-testid="oa-palette"]'), { what: 'palette opens' });
    await js(`(() => {
      const el = document.getElementById('oa-palette-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Exporter');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-palette-item"]').length`)) === 1, { what: 'filtered to one command' });
    // The filename's timestamp has SECOND granularity (exportFilename, matching exporter.py's own
    // strftime("%Y%m%d_%H%M%S")): automated clicks are faster than that, so without this pause the
    // palette export below could legitimately land in the very same second as the first md export.
    await pause(1100);
    await click('[data-testid="oa-palette-item"][data-command-id="export"]');
    await waitFor(() => exists('[data-testid="oa-export-dialog"]'), { what: 'export dialog opens' });
    assert.match(await text('[data-testid="oa-export-dialog"]'), /Depuis : 🌿 Main/);
    await writeFile(join(screenshotDir, 'export-3-palette-dialog.png'), await capturePng(win));
    await click('#oa-export-dialog-md');
    const paletteMdToast = await waitForNewestToast(/^Exporté : conversation_\d{8}_\d{6}\.md$/);
    const paletteMdName = paletteMdToast.text.replace('Exporté : ', '');
    assert.notEqual(paletteMdName, mdName, 'a distinct, freshly timestamped file');
    await readFile(join(alpha, paletteMdName), 'utf8');

    // ── 7. The real worker refuses a folder that does not exist — the actual error path ──
    const missing = join(root, 'disparu');
    let workerRefused = false;
    try { await callWorker('export-conversation', { folder: missing, branchId: 'main', format: 'md', provider: 'p', model: 'm' }); }
    catch (error) { workerRefused = /ENOENT|introuvable/.test(error.message); }
    assert.equal(workerRefused, true, 'the worker refuses a folder that does not exist');

    // ── 8. A click outside the dropdown closes it without exporting ──────────────
    await click('#oa-export-btn');
    await waitFor(() => exists('[data-testid="oa-export-menu"]'));
    const beforeCount = (await readdir(alpha)).filter(name => name.startsWith('conversation_')).length;
    mouseClick(8, 8);
    await waitFor(async () => !(await exists('[data-testid="oa-export-menu"]')), { what: 'backdrop closes the menu' });
    assert.equal((await readdir(alpha)).filter(name => name.startsWith('conversation_')).length, beforeCount, 'closing without choosing a format wrote nothing new');
    await writeFile(join(screenshotDir, 'export-4-after.png'), await capturePng(win));

    process.stdout.write(`PASS conversation export: real ⬇ click + palette, 3 real files on disk (headers, real tool tags, quoting, escape-once), toasts, refused folder (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'export-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
      process.stderr.write(`Console messages: ${JSON.stringify(pageErrors.slice(-20))}\n`);
    } catch (innerError) {
      process.stderr.write(`(diagnostics themselves failed: ${innerError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_EXPORT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL export visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
