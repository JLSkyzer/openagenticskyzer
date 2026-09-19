// Plain Node script. Final end-to-end proof for the agent-tools lot (memory, git, shell, web):
// spawns the REAL packaged executable (real main.cjs, real safeStorage vault, real worker),
// Python stripped from PATH, and drives it through the Chrome DevTools Protocol. A scripted
// local HTTP server plays the language model: for each message it answers with the sequence of
// tool calls prepared by the test, so what is proven is what the app does with them.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'sk-FINAL3-SECRET';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

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

  const home = await mkdtemp(join(tmpdir(), 'openagent-lot3-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-lot3-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-lot3-userdata-'));
  const marker = join(tmpdir(), `openagent-lot3-marker-${Date.now()}.txt`);
  const git = async args => (await run('git', args, { cwd: project })).stdout.trim();
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(project, '.gitignore'), '.openagent/\nbeat.txt\n');
  await writeFile(join(project, 'README.md'), '# Projet de test\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));
  await writeFile(join(project, 'grand.js'), `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'alive'), 3500)"], { stdio: 'ignore' });
    setTimeout(() => {}, 60000);
  `);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node srv.js' } }));
  await writeFile(join(project, 'srv.js'), `const fs = require('node:fs'); console.log('listening'); setInterval(() => fs.appendFileSync('beat.txt', 'x'), 150);`);
  // Committed after the fixture files exist, so the tree starts clean for the git proofs.
  await git(['add', '.']);
  await git(['commit', '-m', 'fixtures']);

  // The scripted "model": each request takes the next prepared step (a tool call or a final text).
  const queue = [];
  const modelServer = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const step = queue.shift() ?? { text: 'ok' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{
        message: step.tool ? { content: '', tool_calls: [{ id: `call-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] } : { content: step.text },
        finish_reason: step.tool ? 'tool_calls' : 'stop',
      }] }));
    });
  });
  const modelPort = await listen(modelServer);
  // An "internal service" that must never be reached through fetch_url.
  let internalHits = 0;
  const internalServer = createServer((_req, res) => { internalHits++; res.end('secret internal page'); });
  const internalPort = await listen(internalServer);

  let child;
  let cdp;
  let exited = false;
  const childOutput = [];
  try {
    const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
    const debugPort = 9342;
    child = spawn(exePath, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: python.sanitizedPath, OPENAGENT_HOME: home, MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => childOutput.push(`[stdout] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr] ${d}`));
    const exitPromise = new Promise(resolve => child.on('exit', (code, signal) => { exited = true; childOutput.push(`[exit] code=${code} signal=${signal}`); resolve(code); }));
    record(`PROOF 2 — packaged executable launched directly (pid=${child.pid}), no npm start, isolated OPENAGENT_HOME`);

    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${debugPort}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000 });
    cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const js = expression => cdp.evaluate(expression);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const toolCards = () => js(`Array.from(document.querySelectorAll('[data-testid="oa-tool-message"]')).map(el => el.textContent)`);
    const untilIdle = () => waitFor(async () => (await text('#oa-send-btn')) === '➤', { timeout: 30000 });
    const untilBanner = () => waitFor(() => exists('[data-testid="oa-permission-banner"]'), { timeout: 15000 });
    const clickBanner = label => js(`Array.from(document.querySelectorAll('[data-testid="oa-permission-banner"] button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const send = async (message, steps) => {
      // A run that was stopped never consumed its closing answer: drop leftovers, they belong to it.
      queue.length = 0;
      queue.push(...steps);
      await js(`(() => {
        const el = document.getElementById('oa-input-ta');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
      // The run has really started once the user's own message is on screen (send-started also
      // turns the button into Stop): without this, "idle" could be read before anything began.
      await waitFor(async () => (await js('document.body.textContent')).includes(message), { timeout: 8000 });
    };
    const tool = (name, args) => ({ tool: [name, args] });
    const present = async file => { try { await stat(file); return true; } catch { return false; } };

    // ── connect the scripted model through the real dialog (real encrypted vault) ────
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

    // ── Proof 3: git_status on the real repository, shown as a READ tool card ──────────
    await send('Quel est l’état du dépôt ?', [tool('git_status', {}), { text: 'Dépôt propre.' }]);
    await untilIdle();
    let cards = await toolCards();
    assert.ok(cards.some(card => card.includes('git_status') && card.includes('READ') && card.includes('Working tree clean.')), `a git_status READ card with the real result: ${JSON.stringify(cards)}`);
    assert.equal(await exists('[data-testid="oa-permission-banner"]'), false, 'a read tool never asks');
    record('PROOF 3 — git_status ran on the real repository and appears as a READ tool card, no permission asked');

    // ── Proof 4: real work — create a file, stage it, commit it (git tools) ────────────
    await send('Ajoute hello.txt et commite', [
      tool('create_file', { path: 'hello.txt', content: 'bonjour' }),
      tool('git_add', { files: 'hello.txt' }),
      tool('git_commit', { message: 'ajout de hello.txt' }),
      { text: 'Commit créé.' },
    ]);
    await untilIdle();
    assert.equal(await readFile(join(project, 'hello.txt'), 'utf8'), 'bonjour');
    assert.match(await git(['log', '--oneline', '-1']), /ajout de hello\.txt/, 'the commit really exists in the repository');
    assert.equal(await git(['status', '--short']), '', 'nothing left uncommitted');
    await cdp.screenshot(join(proofDir, 'lot3-1-git-work.png'));
    record('PROOF 4 — create_file + git_add + git_commit through the agent: the file and the commit exist in the real repository');

    // ── Proof 5: run_command asks first, does nothing before the click, runs after ────
    const ran = join(project, 'ran.txt');
    await send('Lance la commande', [tool('run_command', { command: `node -e "require('fs').writeFileSync('ran.txt','ok');console.log('salut-final')" && echo FIN-COMMANDE-VISIBLE` }), { text: 'Commande faite.' }]);
    await untilBanner();
    assert.match(await text('[data-testid="oa-permission-banner"]'), /run_command/);
    assert.ok((await text('[data-testid="oa-permission-banner"]')).includes('FIN-COMMANDE-VISIBLE'), 'the END of the command is readable before approving it');
    assert.equal(await present(ran), false, 'nothing ran before the decision');
    await cdp.screenshot(join(proofDir, 'lot3-2-shell-banner.png'));
    await clickBanner('Autoriser');
    await untilIdle();
    assert.equal(await readFile(ran, 'utf8'), 'ok', 'the command really ran after the click');
    cards = await toolCards();
    assert.ok(cards.some(card => card.includes('RUN') && card.includes('salut-final')), 'a RUN card with the command output');
    record('PROOF 5 — run_command: permission banner first, nothing executed before the click, real output after');

    // ── Proof 6: "Toujours" is remembered for the session, never written to the settings ──
    await send('Encore une commande', [tool('run_command', { command: `node -e "console.log('deuxieme')"` }), { text: 'Fait.' }]);
    await untilBanner();
    await clickBanner('Toujours');
    await untilIdle();
    await send('Et une troisième', [tool('run_command', { command: `node -e "console.log('troisieme')"` }), { text: 'Fait aussi.' }]);
    await untilIdle();
    assert.equal(await exists('[data-testid="oa-permission-banner"]'), false, 'no banner the third time in the same session');
    assert.ok((await toolCards()).some(card => card.includes('troisieme')), 'the third command ran');
    const projectConfig = await readFile(join(project, '.openagent', 'config.json'), 'utf8').catch(() => '{}');
    assert.equal(projectConfig.includes('shell_ask') || projectConfig.includes('override_permissions'), false, 'no permanent shell switch was written to disk');
    record('PROOF 6 — "Toujours" on a shell command: remembered for the session, nothing persisted to config.json');

    // ── Proof 7: fetch_url cannot reach the machine's own services or local files ─────
    await send('Va lire cette page', [
      tool('fetch_url', { url: `http://127.0.0.1:${internalPort}/admin` }),
      tool('fetch_url', { url: 'file:///C:/Windows/win.ini' }),
      { text: 'Refusé.' },
    ]);
    await untilIdle();
    cards = await toolCards();
    assert.ok(cards.some(card => card.includes('fetch_url') && card.includes('Adresse réseau interne ou privée refusée')), 'the loopback URL was refused');
    assert.ok(cards.some(card => card.includes('Protocole non autorisé')), 'the file:// URL was refused');
    assert.equal(internalHits, 0, 'the internal service received not a single request');
    await cdp.screenshot(join(proofDir, 'lot3-3-ssrf-refused.png'));
    record('PROOF 7 — fetch_url refused a loopback URL and a file:// URL; the internal server got 0 requests');

    // ── Proof 8: git argument injection is refused, nothing executes ────────────────
    await send('Pousse', [
      tool('git_push', { remote: 'ext::sh -c "touch pwned.txt"' }),
      tool('git_checkout', { branch: '-f' }),
      { text: 'Refusé.' },
    ]);
    // git_push is a "shell" tool so it may ask; approving must not be enough to make it run.
    await waitFor(async () => (await exists('[data-testid="oa-permission-banner"]')) || (await text('#oa-send-btn')) === '➤', { timeout: 15000 });
    if (await exists('[data-testid="oa-permission-banner"]')) await clickBanner('Autoriser');
    await untilIdle();
    cards = await toolCards();
    assert.ok(cards.some(card => card.includes('git_push') && card.includes('invalide')), 'git_push refused the transport-style remote');
    assert.ok(cards.some(card => card.includes('git_checkout') && card.includes('invalide')), 'git_checkout refused an option-like name');
    assert.equal(await present(join(project, 'pwned.txt')), false, 'no injected command ran');
    record('PROOF 8 — git_push with an ext:: remote and git_checkout -f were refused even after approval; no command ran');

    // ── Proof 9: Stop kills the long command AND everything it started ──────────────
    await send('Lance le long processus', [tool('run_command', { command: 'node grand.js', timeout: 60 }), { text: 'Fini.' }]);
    await waitFor(async () => (await text('#oa-send-btn')) === '■');
    await sleep(1000);
    await click('#oa-send-btn');
    await untilIdle();
    await sleep(4500);
    assert.equal(await present(marker), false, 'the grandchild never wrote its marker: the whole tree was killed');
    record('PROOF 9 — Stop killed the running command and its child process (marker never written)');

    // ── Proof 10: closing the app stops a background dev server with its whole tree ────
    await send('Démarre le serveur', [tool('run_command', { command: 'npm run dev' }), { text: 'Serveur lancé.' }]);
    await untilIdle();
    cards = await toolCards();
    assert.ok(cards.some(card => card.includes('Server started in background')), `the dev server was started in the background; last cards: ${JSON.stringify(cards.slice(-2))}`);
    const beat = join(project, 'beat.txt');
    await sleep(700);
    const before = (await readFile(beat, 'utf8')).length;
    assert.ok(before > 0, 'the server is running and writing');
    await cdp.screenshot(join(proofDir, 'lot3-4-server-running.png'));
    // Close the app the way a user does: closing the window makes Electron quit through before-quit.
    const version = await httpGetJson(`http://127.0.0.1:${debugPort}/json/version`);
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    await browser.send('Browser.close').catch(() => {});
    const code = await Promise.race([exitPromise, sleep(20000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'the app exited after the window was closed');
    await sleep(600);
    const after = (await readFile(beat, 'utf8')).length;
    await sleep(1000);
    assert.equal((await readFile(beat, 'utf8')).length, after, 'the dev server stopped with the app: nothing writes anymore');
    record(`PROOF 10 — closing the app (exit code ${code}) stopped the background dev server and its process tree`);

    await writeFile(join(proofDir, 'lot3-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the agent tools lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    throw error;
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child && !exited) child.kill();
    await Promise.all([modelServer, internalServer].map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); })));
    await sleep(500);
    await rm(marker, { force: true });
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await Promise.all([home, project, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot3: ${error.stack || error}\n`);
  process.exitCode = 1;
});
