// Plain Node script, run ONCE after `npm run package:win`. Launches the PACKAGED executable
// (release/win-unpacked/openagent.exe) and proves, in the real packaged main process, that the startup erasure of the
// online-provider secrets (core/online-secrets.mts, through main.cjs::prepareDataHome) runs in the folder the data-home
// redirect points to (R4) — resolved by core/data-home.cjs, the CommonJS module main.cjs requires at startup — exactly
// where the packaged worker keeps the rest of the data, and never in the folder that only holds the pointer.
//
// Isolation: OPENAGENT_HOME is a temp folder that takes the place of ~/.openagent; its redirect.json points to a
// second temp folder. userData is a third temp folder (--user-data-dir and OPENAGENT_USERDATA_DIR). The real data
// home is never read nor written. Updates are switched off: no network. The child gets no *_API_KEY / *_BASE_URL
// from this shell.
//
// Step 0 launches the exe once more on a home whose redirect.json is CORRUPT: it must exit with code 1, at once.
// OPENAGENT_STARTUP_ERROR_FILE (test-only) makes main.cjs write the error text to a file instead of the native
// dialog.showErrorBox, which would block until dismissed. So this proves the exit, the lock released (the main
// launch right after uses the same userData) and the exact text; it does NOT prove the native box itself is shown.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, writeFile, readFile, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, waitForPage, cdpEvaluate } = require('./cdp-helper.cjs');

const present = file => access(file).then(() => true, () => false);

/** This shell's environment without any provider key or endpoint, plus the test's own variables. */
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/_API_KEY$|_BASE_URL$/i.test(name)));
  return { ...env, OPENAGENT_DISABLE_UPDATES: '1', ...extra };
}

/** Resolves with the exit code, or rejects when the process is still running after `timeoutMs`. */
function exitWithin(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running after ${timeoutMs} ms`)), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function main() {
  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  const userData = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-userdata-'));
  const home = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-home-'));
  const redirected = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-redirected-'));
  // The pointer, as Réglages › Général › Répertoire de données writes it. The REDIRECTED folder holds what an earlier
  // version left: the connections vault and a config.json with both provider keys and the kept Hugging Face token.
  // Decoys in the pointer's own folder: a main process that erased in the wrong folder would remove or change them.
  await writeFile(join(home, 'redirect.json'), JSON.stringify({ data_dir: redirected }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ current_provider: 'groq', current_model: 'llama-leurre', hf_token: 'hf_LEURRE' }));
  await writeFile(join(home, 'connections.v1.json'), 'leurre-coffre');
  await writeFile(join(redirected, 'connections.v1.json'), JSON.stringify({ version: 1, payload: 'eA==' }));
  await writeFile(join(redirected, 'config.json'), JSON.stringify({ current_provider: 'mistral', current_model: 'modele-en-ligne', hf_token: 'hf_GARDE', theme: 'dark' }));
  const homeConfigBefore = await readFile(join(home, 'config.json'), 'utf8');
  const homeVaultBefore = await readFile(join(home, 'connections.v1.json'), 'utf8');

  // 0. A corrupt redirect.json: a clear message and an immediate exit with code 1 — never a process left running
  //    with no window, holding the single-instance lock.
  const corruptHome = await mkdtemp(join(tmpdir(), 'openagent-package-datahome-corrupt-'));
  const corruptRedirect = join(corruptHome, 'redirect.json');
  const errorFile = join(corruptHome, 'startup-error.txt');
  await writeFile(corruptRedirect, '{"data_dir": "C:\\coup');
  try {
    const failing = spawn(exePath, [`--user-data-dir=${userData}`], {
      stdio: 'ignore',
      env: cleanEnv({ OPENAGENT_HOME: corruptHome, OPENAGENT_USERDATA_DIR: userData, OPENAGENT_STARTUP_ERROR_FILE: errorFile }),
    });
    let code;
    try { code = await exitWithin(failing, 30000); } catch (error) { failing.kill(); throw error; }
    assert.equal(code, 1, 'the packaged app exits with code 1');
    const text = await readFile(errorFile, 'utf8');
    process.stdout.write(`startup error shown to the user:\n${text}`);
    assert.match(text, /^openagent — dossier de données illisible\n/, 'the title');
    assert.ok(text.includes(`JSON illisible : ${corruptRedirect}`), 'the reason, naming the file');
    assert.ok(text.includes(`Corrige ou supprime ${corruptRedirect}, puis relance openagent.`), 'what to do');
    assert.equal(await present(join(corruptHome, 'connections.v1.json')), false, 'no vault written next to the corrupt pointer');
  } finally {
    await rm(corruptHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  const port = 9336;
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: cleanEnv({ OPENAGENT_HOME: home, OPENAGENT_USERDATA_DIR: userData }),
  });
  try {
    const version = await waitFor(() => httpGetJson(`http://127.0.0.1:${port}/json/version`), { timeout: 30000, what: 'the packaged exe debug port' });
    assert.match(version['User-Agent'], /Electron\/44\.4\.2/, 'the packaged exe answered');
    const page = await waitForPage(port);
    assert.match(page.url, /app\.asar[\\/]renderer-dist[\\/]index\.html$/, 'loaded from the packaged asar bundle');
    const ask = request => cdpEvaluate(page.webSocketDebuggerUrl, `window.openagent.request(${JSON.stringify(request)})`);

    // 1. The page is up, so the startup erasure (before createWindow) is done: in the REDIRECTED folder the vault is
    //    gone and both provider keys left config.json; hf_token and the other settings stay.
    assert.equal(await present(join(redirected, 'connections.v1.json')), false, 'the vault is erased from the redirected folder');
    const cleaned = JSON.parse(await readFile(join(redirected, 'config.json'), 'utf8'));
    process.stdout.write(`redirected config.json keys after the start: ${JSON.stringify(Object.keys(cleaned))}\n`);
    assert.equal('current_provider' in cleaned, false, 'current_provider erased');
    assert.equal('current_model' in cleaned, false, 'current_model erased');
    assert.equal(cleaned.hf_token, 'hf_GARDE', 'hf_token is kept');
    assert.equal(cleaned.theme, 'dark', 'the other settings are kept');
    // No copy written by the cleaning still holds the keys (JsonStore's one-time backup is skipped for it).
    if (await present(join(redirected, 'config.json.pre-electron.bak'))) {
      const backup = await readFile(join(redirected, 'config.json.pre-electron.bak'), 'utf8');
      assert.equal(/current_provider|current_model|mistral|modele-en-ligne/.test(backup), false, 'no backup holds the erased keys');
    }

    // 2. The decoys in the folder that only holds the pointer are untouched.
    assert.equal(await readFile(join(home, 'connections.v1.json'), 'utf8'), homeVaultBefore, 'the decoy vault is untouched');
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), homeConfigBefore, 'the decoy config.json is untouched');

    // 3. The packaged worker resolved the very same folder (one module for both processes).
    const globalSettings = await ask({ op: 'global-settings' });
    process.stdout.write(`worker data_home: ${globalSettings.data_home}\n`);
    assert.equal(globalSettings.data_home, redirected, 'the worker reports the redirected folder as its data home');
    await ask({ op: 'save-global-settings', payload: { patch: { theme: 'light' } } });
    assert.equal(JSON.parse(await readFile(join(redirected, 'config.json'), 'utf8')).theme, 'light', 'the worker writes in the redirected folder');
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), homeConfigBefore, 'the pointer folder is untouched');

    process.stdout.write('PASS packaged data home: main.cjs and the worker follow redirect.json; the startup erasure ran in the redirected folder only, hf_token kept\n');
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
