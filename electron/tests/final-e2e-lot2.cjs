// Plain Node script. Final end-to-end proof for the settings + model selector lot: spawns
// the REAL packaged executable (release/win-unpacked/openagent.exe) — real main.cjs, real
// safeStorage vault, real worker, nothing mocked — with Python stripped from PATH, and
// drives it through the Chrome DevTools Protocol. Two local fake HTTP providers stand in
// for real vendors; secrets used here are synthetic.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp, checkPythonAbsent } = require('./cdp-helper.cjs');

const KEY = 'sk-FINAL-SECRET';
const HF = 'hf_FINAL-SECRET';
const MODEL = 'final-model';

function fakeProvider(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, model: JSON.parse(body).model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\r\n\r\n`);
      response.write('data: [DONE]\r\n\r\n');
      response.end();
    });
  });
  return { requests, server };
}
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

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

  const home = await mkdtemp(join(tmpdir(), 'openagent-lot2-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-lot2-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-lot2-userdata-'));
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: project, last_used: new Date().toISOString() }]));
  const providerA = fakeProvider('final-reponse-A');
  const providerB = fakeProvider('final-reponse-B');
  const portA = await listen(providerA.server);
  const portB = await listen(providerB.server);
  const urlA = `http://127.0.0.1:${portA}/v1`;
  const urlB = `http://127.0.0.1:${portB}/v1`;

  let child;
  let cdp;
  const childOutput = [];
  try {
    const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
    const debugPort = 9341;
    child = spawn(exePath, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
      env: { ...process.env, PATH: python.sanitizedPath, OPENAGENT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => childOutput.push(`[stdout] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr] ${d}`));
    child.on('exit', (code, signal) => childOutput.push(`[exit] code=${code} signal=${signal}`));
    record(`PROOF 2 — packaged executable launched directly (pid=${child.pid}), no npm start, isolated OPENAGENT_HOME`);

    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${debugPort}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000 });
    cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const js = expression => cdp.evaluate(expression);
    const ipc = (op, payload) => cdp.evaluate(`window.openagent.request(${JSON.stringify({ op, payload })})`, true);
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const exists = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
    const bodyText = () => js('document.body.textContent');
    const untilText = (selector, pattern, timeout = 8000) => waitFor(async () => pattern.test(await text(selector)), { timeout });
    const untilExists = (selector, timeout = 8000) => waitFor(() => exists(selector), { timeout });
    const untilGone = (selector, timeout = 8000) => waitFor(async () => !(await exists(selector)), { timeout });
    const openTab = async id => { await click(`[data-testid="oa-settings-tab"][data-tab="${id}"]`); await new Promise(r => setTimeout(r, 250)); };
    const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
    const send = async message => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(message)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);

    // A real conversation (with a fork) to clear later, written through the real ops.
    await ipc('save-messages', { folder: project, messages: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'historique-final' }] });
    await ipc('fork', { folder: project, source: 'main', count: 2, label: 'essai' });

    await untilExists('[data-testid="oa-folder-entry"]');
    await click('[data-testid="oa-folder-entry"]');
    await waitFor(async () => (await bodyText()).includes('historique-final'), { timeout: 8000 });
    record('PROOF 3 — real folder activated by a real click on the sidebar entry, its saved history is on screen');

    // ── Proof 4: Général / Contexte / Permissions save to the real config.json ─────
    await click('#oa-settings-btn');
    await untilExists('[data-testid="oa-settings-dialog"]');
    await click('[data-setting="agent_mode"][value="plan"]');
    await click('[data-setting="animations"]');
    await setValue('[data-setting="hf_token"]', HF);
    await openTab('context');
    await setValue('[data-setting="max_tokens"]', 32000);
    await setValue('[data-setting="reserved_tokens"]', 4096);
    await setValue('[data-setting="session_retention_days"]', 90);
    await openTab('permissions');
    await setValue('[data-setting="permission_mode"]', 'strict');
    await click('[data-setting="files_ask"]');
    await click('#oa-settings-save-btn');
    await untilText('[data-testid="oa-settings-status"]', /Paramètres sauvegardés/);
    const config = await readJson(join(home, 'config.json'));
    assert.deepEqual(
      { agent_mode: config.agent_mode, animations: config.animations, hf_token: config.hf_token, max_tokens: config.max_tokens, reserved_tokens: config.reserved_tokens, session_retention_days: config.session_retention_days, permission_mode: config.permission_mode, files_ask: config.files_ask },
      { agent_mode: 'plan', animations: false, hf_token: HF, max_tokens: 32000, reserved_tokens: 4096, session_retention_days: 90, permission_mode: 'strict', files_ask: true },
    );
    assert.equal('restore_last_folder' in config, false, 'untouched keys are not written');
    assert.equal(await js(`document.body.innerHTML.includes(${JSON.stringify(HF)}) || Array.from(document.querySelectorAll('input')).some(i => i.value.includes(${JSON.stringify(HF)}))`), false, 'the HuggingFace token never comes back to the page');
    await openTab('general');
    await cdp.screenshot(join(proofDir, 'lot2-1-settings-saved.png'));
    record('PROOF 4 — global settings edited by real clicks/typing landed exactly in config.json; the token was stored but is not on the page');

    // ── Proof 5: per-project settings land in the project's own config.json ────────
    await openTab('folder');
    await setValue('[data-project-setting="agent_mode"]', 'plan');
    await click('#oa-folder-save-btn');
    await untilText('[data-testid="oa-folder-status"]', /Paramètres dossier sauvegardés/);
    assert.equal((await readJson(join(project, '.openagent', 'config.json'))).agent_mode, 'plan');
    await click('#oa-settings-close-btn');
    record('PROOF 5 — per-project settings written to <projet>/.openagent/config.json');

    // ── Proof 6: the model selector drives the next message (real encrypted vault) ──
    assert.match(await text('#oa-model-btn'), /Aucun modèle/);
    await click('#oa-model-btn');
    await untilExists('[data-testid="oa-model-active"]');
    await setValue('[data-model-field="model"]', MODEL);
    await setValue('[data-model-field="base_url"]', urlA);
    await setValue('[data-model-field="api_key"]', KEY);
    await click('#oa-model-save-btn');
    await untilText('[data-testid="oa-model-status"]', /Connexion enregistrée/);
    const vault = await readFile(join(home, 'connections.v1.json'), 'utf8');
    assert.equal(vault.includes(KEY), false, 'the vault file (real safeStorage) holds no clear-text key');
    assert.equal((await bodyText()).includes(KEY), false, 'the key is not on the page');
    await click('#oa-model-close-btn');
    await send('Bonjour A');
    await waitFor(async () => (await bodyText()).includes('final-reponse-A'), { timeout: 10000 });
    assert.deepEqual(providerA.requests, [{ authorization: `Bearer ${KEY}`, model: MODEL }]);
    record('PROOF 6a — saved model/URL/key: the next message really reached server A with Bearer key and the saved model');

    await click('#oa-model-btn');
    await untilExists('[data-testid="oa-model-active"]');
    await setValue('[data-model-field="base_url"]', urlB);
    await click('#oa-model-save-btn');
    await untilExists('#oa-model-confirm-ok-btn');
    await cdp.screenshot(join(proofDir, 'lot2-2-model-confirm.png'));
    await click('#oa-model-confirm-cancel-btn');
    await untilGone('#oa-model-confirm-ok-btn');
    assert.equal((await ipc('connection-snapshot', { folder: project })).base_url, urlA, 'Annuler left the connection on A');
    await click('#oa-model-save-btn');
    await untilExists('#oa-model-confirm-ok-btn');
    await click('#oa-model-confirm-ok-btn');
    await untilText('[data-testid="oa-model-status"]', /Connexion enregistrée/);
    await click('#oa-model-close-btn');
    await send('Bonjour B');
    await waitFor(async () => (await bodyText()).includes('final-reponse-B'), { timeout: 10000 });
    assert.deepEqual(providerB.requests, [{ authorization: `Bearer ${KEY}`, model: MODEL }]);
    assert.equal(providerA.requests.length, 1, 'server A received nothing more');
    record('PROOF 6b — re-binding the key to another URL required a confirmation; after it the next message reached server B');

    // ── Proof 7: the danger zone acts for real ─────────────────────────────────────
    await click('#oa-settings-btn');
    await untilExists('[data-testid="oa-settings-dialog"]');
    await openTab('appearance');
    await click('#oa-theme-light-btn');
    await waitFor(async () => (await js(`document.documentElement.getAttribute('data-theme')`)) === 'light');
    await openTab('danger');
    await click('#oa-danger-clear-btn');
    await untilExists('#oa-confirm-ok-btn');
    await cdp.screenshot(join(proofDir, 'lot2-3-danger-confirm.png'));
    await click('#oa-confirm-ok-btn');
    await untilText('[data-testid="oa-danger-status"]', /Historique effacé/);
    const conversation = await readJson(join(project, '.openagent', 'conversations.json'));
    assert.equal(conversation.branches.length, 1);
    assert.deepEqual(conversation.branches[0].messages, []);
    assert.equal((await bodyText()).includes('historique-final'), false, 'the visible chat is empty too');
    await click('#oa-danger-remove-btn');
    await untilText('[data-testid="oa-danger-status"]', /Dossier retiré/);
    assert.equal(await js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length`), 0);
    assert.deepEqual(await readJson(join(home, 'folders.json')), []);
    assert.ok((await stat(project)).isDirectory(), 'project files untouched');
    await click('#oa-danger-reset-btn');
    await untilExists('#oa-confirm-ok-btn');
    await click('#oa-confirm-ok-btn');
    await untilText('[data-testid="oa-danger-status"]', /Paramètres réinitialisés/);
    await waitFor(async () => (await js(`document.documentElement.getAttribute('data-theme')`)) === 'dark');
    assert.deepEqual(await readJson(join(home, 'config.json')), {}, 'nothing custom is left in config.json');
    record('PROOF 7 — clear history / remove folder / reset settings acted on disk and on screen; project files untouched');

    await writeFile(join(proofDir, 'lot2-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of the settings + model selector lot on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    throw error;
  } finally {
    cdp?.close();
    child?.kill();
    await Promise.all([providerA.server, providerB.server].map(server => new Promise(resolve => server.close(() => resolve()))));
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await Promise.all([home, project, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e lot2: ${error.stack || error}\n`);
  process.exitCode = 1;
});
