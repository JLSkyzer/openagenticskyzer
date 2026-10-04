// Run with Electron, not node. Proves the "Outils" tab's MCP server list end to end through the
// real UI and the REAL worker.mjs mcp-list/mcp-add/mcp-remove ops (real mcp.json on disk). The
// deeper proof — a real agent turn actually spawning a real MCP server process and calling one of
// its tools — already exists at the worker level in tests/worker-mcp.test.mts (a real fake stdio
// MCP server, no mocking of the protocol); this visual test does not repeat that here, only the
// UI plumbing around the config list.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
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
  const root = await mkdtemp(join(tmpdir(), 'openagent-mcp-visual-'));
  const home = join(root, 'home');
  await mkdir(home);

  const screenshotDir = process.env.OPENAGENT_MCP_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    ipcMain.handle('backend-request', (_event, request) => {
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
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const setInput = (selector, value) => js(`(() => {
      const el = document.querySelector(${q(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    await click('#oa-settings-btn');
    await waitFor(() => js(`!!document.querySelector('[data-testid="oa-settings-tab"][data-tab="tools"]')`), { what: 'Outils tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
    await waitFor(() => exists('[data-testid="oa-mcp-empty"]'), { what: 'empty MCP list shown initially' });
    await writeFile(join(screenshotDir, 'mcp-1-empty.png'), await capturePng(win));

    // ── A real click adds a real server definition, persisted to a real mcp.json ──────────────────
    await setInput('[data-testid="oa-mcp-command-input"]', 'npx -y @modelcontextprotocol/server-filesystem /tmp');
    await click('#oa-mcp-add-btn');
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-mcp-entry"]').length`)) === 1, { what: 'server appears in the list' });
    assert.match(await text('[data-testid="oa-mcp-entry"]'), /npx.*server-filesystem/);
    assert.equal(await text('[data-testid="oa-mcp-not-started"]'), 'non démarré — ses outils seront chargés au prochain message', 'listed without being started (parity row 33)');
    const onDisk = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].command, 'npx');
    await writeFile(join(screenshotDir, 'mcp-2-added.png'), await capturePng(win));

    // ── A real click removes it, for real, from disk too ────────────────────────────────────────────
    await click('[data-testid="oa-mcp-remove"]');
    await waitFor(() => exists('[data-testid="oa-mcp-empty"]'), { what: 'list empty again after removal' });
    const afterRemoval = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8'));
    assert.equal(afterRemoval.length, 0);

    // ── A real project .mcp.json shows the "projet" badge, with ✕ disabled ───────
    const alpha = join(home, '..', 'alpha'); // sibling of home, a real project folder
    await (await import('node:fs/promises')).mkdir(alpha, { recursive: true });
    await (await import('node:fs/promises')).writeFile(join(alpha, '.mcp.json'), JSON.stringify({
      mcpServers: { teamserver: { command: 'npx', args: ['-y', 'some-pkg'] } },
    }));
    await (await import('node:fs/promises')).writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));
    await win.webContents.reload();
    await pause(500);
    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'alpha listed after seeding folders.json' });
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(() => exists('#oa-input-ta'), { what: 'alpha activated' });
    await click('#oa-settings-btn');
    await waitFor(() => js(`!!document.querySelector('[data-testid="oa-settings-tab"][data-tab="tools"]')`), { what: 'Outils tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
    await waitFor(() => exists('[data-testid="oa-mcp-project-badge"]'), { what: 'project badge shown for the .mcp.json server' });
    const projectEntryRemoveDisabled = await js(`document.querySelector('[data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-remove"]').disabled`);
    assert.equal(projectEntryRemoveDisabled, true, 'a project-scope server cannot be removed from the UI');
    assert.equal(await exists('[data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-not-started"]'), false, 'an unapproved project server is « non approuvé », not « non démarré »: no message will start it');
    await writeFile(join(screenshotDir, 'mcp-3-project-badge.png'), await capturePng(win));

    // ── A real click adds a real remote server definition, persisted to the real mcp.json ───────
    await js(`(() => {
      const el = document.querySelector('[data-testid="oa-mcp-remote-url-input"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'https://example.com/mcp');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click('#oa-mcp-add-remote-btn');
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-mcp-entry"][data-scope="global"]').length`)) === 1, { what: 'remote server appears in the list' });
    const onDiskAfterRemote = JSON.parse(await (await import('node:fs/promises')).readFile(join(home, 'mcp.json'), 'utf8'));
    assert.ok(onDiskAfterRemote.some(e => e.type === 'http' && e.url === 'https://example.com/mcp'), 'really persisted to mcp.json');

    // ── Regression check: adding a global server must not drop the project-scope entry from view ──
    // (handleAddRemote/handleAdd/handleRemove must re-fetch the MERGED list, not just the global
    // mutation's own return value, or the "projet"-badged .mcp.json entry silently disappears.)
    await waitFor(() => exists('[data-testid="oa-mcp-entry"][data-scope="project"]'), { what: 'project-scope server still shown after adding a global remote server' });
    assert.match(await text('[data-testid="oa-mcp-entry"][data-scope="project"]'), /teamserver|npx.*some-pkg/, 'the surviving project entry is really teamserver, not a stale/empty node');
    await writeFile(join(screenshotDir, 'mcp-4-remote-added.png'), await capturePng(win));

    // ── Parity row 33: the Outils tab never starts a server; a real turn does, and the tab then shows what it learned ──
    // Two real stdio servers (the test fixture, run by this Electron binary as Node): one healthy whose start writes a
    // witness file, one that crashes at startup. They replace the remote example.com entry: no turn may reach it.
    const fixture = path.join(__dirname, 'fixtures', 'fake-mcp-server.cjs');
    const witness = join(root, 'mcp-started.txt');
    const asNode = { ELECTRON_RUN_AS_NODE: '1' };
    await writeFile(join(home, 'mcp.json'), JSON.stringify([
      { id: 'fake-ok', command: process.execPath, args: [fixture, 'ok'], env: { ...asNode, FAKE_MCP_MARKER: witness }, added_at: '2026-10-04T10:00:02.000Z' },
      { id: 'fake-crash', command: process.execPath, args: [fixture, 'crash'], env: { ...asNode, FAKE_MCP_CRASH: '1' }, added_at: '2026-10-04T10:00:01.000Z' },
    ]));
    const reopenTools = async () => {
      await click('[data-testid="oa-settings-tab"][data-tab="general"]');
      await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
    };
    const globalStatus = () => js(`[...document.querySelectorAll('[data-testid="oa-mcp-entry"][data-scope="global"]')].map(e => e.querySelector('[data-testid="oa-mcp-tools"], [data-testid="oa-mcp-error"], [data-testid="oa-mcp-not-started"]')?.dataset.testid + ':' + e.querySelector('[data-testid="oa-mcp-tools"], [data-testid="oa-mcp-error"], [data-testid="oa-mcp-not-started"]')?.textContent)`);
    await reopenTools();
    await waitFor(async () => (await globalStatus()).length === 2, { what: 'the two fixture servers listed' });
    assert.deepEqual(await globalStatus(), [
      'oa-mcp-not-started:non démarré — ses outils seront chargés au prochain message',
      'oa-mcp-not-started:non démarré — ses outils seront chargés au prochain message',
    ]);
    await pause(500);
    assert.equal(await (await import('node:fs/promises')).access(witness).then(() => true, () => false), false, 'opening the Outils tab started no server');

    // A real turn in alpha, through the real worker, with a real local model server that just answers.
    const modelServer = require('node:http').createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
    try {
      const connection = { provider: 'test', base_url: `http://127.0.0.1:${modelServer.address().port}/v1`, model: 'test-model', api_key: 'fake' };
      const runId = await new Promise((resolve, reject) => {
        const id = `turn-${Math.random()}`;
        pending.set(id, { resolve: result => resolve(result.runId), reject });
        worker.postMessage({ id, op: 'send', payload: { folder: alpha, branchId: 'main', text: 'bonjour', connection } });
      });
      const end = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the turn did not end within 30 s')), 30000);
        worker.on('message', function onEnd(message) {
          if (message?.type !== 'event' || message.event !== 'agent' || message.runId !== runId || !['done', 'error', 'stopped'].includes(message.kind)) return;
          clearTimeout(timer);
          worker.off('message', onEnd);
          resolve(message);
        });
      });
      assert.equal(end.kind, 'done', `the turn ended: ${JSON.stringify(end)}`);
    } finally {
      modelServer.closeAllConnections();
      await new Promise(resolve => modelServer.close(resolve));
    }
    assert.equal(await (await import('node:fs/promises')).access(witness).then(() => true, () => false), true, 'the turn started the healthy server');

    await reopenTools();
    // Both entries present: right after the remount the list is empty, and `every` holds on an empty list.
    await waitFor(async () => {
      const statuses = await globalStatus();
      return statuses.length === 2 && statuses.every(status => /^oa-mcp-(tools|error):/.test(status));
    }, { what: 'the tab shows what the turn learned' });
    const [okStatus, crashStatus] = await globalStatus();
    assert.equal(okStatus, 'oa-mcp-tools:mcp_echo, mcp_boom', 'the healthy server shows the tools the turn offered');
    assert.match(crashStatus, /^oa-mcp-error:.*serveur MCP terminé/, 'the crashed server shows its error, not « non démarré »');
    assert.equal(await exists('[data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-tools"], [data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-error"], [data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-not-started"]'), false, 'the unapproved project server still shows no status');
    await writeFile(join(screenshotDir, 'mcp-5-after-turn.png'), await capturePng(win));

    process.stdout.write(`PASS mcp tab: real add/remove through the real worker, real mcp.json, servers listed without being started, then their tools and error after a real turn (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } catch (error) {
    try {
      await writeFile(join(screenshotDir, 'mcp-failure.png'), await capturePng(win));
      process.stderr.write(`Page text at failure: ${JSON.stringify((await win.webContents.executeJavaScript('document.body.textContent')).slice(0, 700))}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`(diagnostics failed: ${diagnosticError.message})\n`);
    }
    throw error;
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_MCP_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL mcp visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
