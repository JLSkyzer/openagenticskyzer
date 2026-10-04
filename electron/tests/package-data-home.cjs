// Plain Node script, run ONCE after `npm run package:win`. Launches the PACKAGED executable
// (release/win-unpacked/openagent.exe) and proves, in the real packaged main process, that the connections vault
// follows the data-home redirect (R4) through core/data-home.cjs — the CommonJS module main.cjs requires at
// startup — exactly where the packaged worker keeps the rest of the data.
//
// Isolation: OPENAGENT_HOME is a temp folder that takes the place of ~/.openagent; its redirect.json points to a
// second temp folder. userData is a third temp folder (--user-data-dir and OPENAGENT_USERDATA_DIR). The real data
// home is never read nor written. Updates are switched off: no network.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, writeFile, readFile, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, waitForPage, cdpEvaluate } = require('./cdp-helper.cjs');

const present = file => access(file).then(() => true, () => false);

async function main() {
  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const userData = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-userdata-'));
  const home = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-home-'));
  const redirected = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-redirected-'));
  // The pointer, as Réglages › Général › Répertoire de données writes it, and a decoy in the pointer's own folder:
  // a main process that ignored the redirect would report the decoy provider (groq).
  await writeFile(join(home, 'redirect.json'), JSON.stringify({ data_dir: redirected }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ current_provider: 'groq' }));
  await writeFile(join(redirected, 'config.json'), JSON.stringify({ current_provider: 'mistral' }));
  const homeConfigBefore = await readFile(join(home, 'config.json'), 'utf8');

  const port = 9336;
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      OPENAGENT_HOME: home,
      OPENAGENT_USERDATA_DIR: userData,
      OPENAGENT_DISABLE_UPDATES: '1',
    },
  });
  try {
    const version = await waitFor(() => httpGetJson(`http://127.0.0.1:${port}/json/version`), { timeout: 30000, what: 'the packaged exe debug port' });
    assert.match(version['User-Agent'], /Electron\/44\.4\.2/, 'the packaged exe answered');
    const page = await waitForPage(port);
    assert.match(page.url, /app\.asar[\\/]renderer-dist[\\/]index\.html$/, 'loaded from the packaged asar bundle');
    const ask = request => cdpEvaluate(page.webSocketDebuggerUrl, `window.openagent.request(${JSON.stringify(request)})`);

    // 1. READ: the main process composes the connection from the REDIRECTED folder's config.json.
    const first = await ask({ op: 'connection-snapshot', payload: { folder: null } });
    process.stdout.write(`connection-snapshot (before save): ${JSON.stringify(first)}\n`);
    // (Connections.compose takes `current_provider` from the global config.json; `current_model` only from a project's.)
    assert.equal(first.provider, 'mistral', 'the provider comes from the redirected folder, not the pointer folder');

    // 2. WRITE then READ BACK: the vault file lands in the redirected folder, and the next snapshot reads it there.
    const saved = await ask({ op: 'save-connection', payload: { folder: null, patch: { provider: 'openrouter', model: 'modele-enregistre-dans-le-coffre' } } });
    assert.equal(saved.model, 'modele-enregistre-dans-le-coffre');
    assert.equal(await present(join(redirected, 'connections.v1.json')), true, 'the vault is written in the redirected folder');
    assert.equal(await present(join(home, 'connections.v1.json')), false, 'and never in the folder that only holds the pointer');
    const vault = JSON.parse(await readFile(join(redirected, 'connections.v1.json'), 'utf8'));
    assert.equal(vault.version, 1);
    assert.doesNotMatch(vault.payload, /modele-enregistre/, 'the vault on disk is encrypted by the OS');
    const second = await ask({ op: 'connection-snapshot', payload: { folder: null } });
    process.stdout.write(`connection-snapshot (after save): ${JSON.stringify(second)}\n`);
    assert.equal(second.provider, 'openrouter');
    assert.equal(second.model, 'modele-enregistre-dans-le-coffre', 'read back from the vault in the redirected folder');
    assert.equal(second.model_source, 'global', 'the model comes from the vault itself');

    // 3. The packaged worker resolved the very same folder (one module for both processes).
    const globalSettings = await ask({ op: 'global-settings' });
    process.stdout.write(`worker data_home: ${globalSettings.data_home}\n`);
    assert.equal(globalSettings.data_home, redirected, 'the worker reports the redirected folder as its data home');
    await ask({ op: 'save-global-settings', payload: { patch: { theme: 'light' } } });
    assert.equal(JSON.parse(await readFile(join(redirected, 'config.json'), 'utf8')).theme, 'light', 'the worker writes in the redirected folder');
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), homeConfigBefore, 'the pointer folder is untouched');

    process.stdout.write('PASS packaged data home: main.cjs and the worker follow redirect.json; the vault is read and written in the redirected folder\n');
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 1500)); // let the killed process release its files
    for (const dir of [userData, home, redirected]) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL packaged data home: ${error.stack || error}\n`);
  process.exitCode = 1;
});
