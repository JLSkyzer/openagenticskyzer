// Plain Node script — NOT run through the Electron binary like the other *-visual.cjs
// tests. Spawns the PACKAGED executable (release/win-unpacked/openagent.exe) exactly
// how a real user would launch it (never via npm start / node), and proves it opens a
// real window with the real UI entirely outside the dev/test harness.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
        });
      })
      .on('error', reject);
  });
}

async function waitFor(fn, { timeout = 10000, interval = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Not up yet — keep polling until the timeout.
    }
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  // The bundled embedding model (build.extraResources): real files beside app.asar, the onnx at its committed size.
  const { EMBEDDING_FILES, EMBEDDING_MODEL } = await import('../core/embeddings.mts');
  const packagedModel = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'models', ...EMBEDDING_MODEL.split('/'));
  for (const file of EMBEDDING_FILES) assert.ok((await stat(path.join(packagedModel, file))).isFile(), `packaged ${file}`);
  assert.equal((await stat(path.join(packagedModel, 'onnx', 'model_quantized.onnx'))).size, 22_972_370, 'the packaged onnx is the committed one');
  process.stdout.write(`bundled embedding model packaged: ${EMBEDDING_FILES.join(', ')} under resources/models/${EMBEDDING_MODEL}\n`);
  // The CUDA pack manifest (build.extraResources): the packaged copy is the committed one, byte for byte — the app
  // downloads and checks exactly the parts it names (main.cjs workerOptions: <resources>/cuda-pack/manifest.json).
  const packagedManifest = await readFile(path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'cuda-pack', 'manifest.json'));
  const committedManifest = await readFile(path.join(__dirname, '..', 'resources', 'cuda-pack', 'manifest.json'));
  assert.ok(packagedManifest.equals(committedManifest), 'the packaged CUDA pack manifest is the committed one');
  process.stdout.write(`CUDA pack manifest packaged: resources/cuda-pack/manifest.json (${packagedManifest.length} bytes, equal to the committed one)\n`);
  // The CUDA pack's download source (C-1, final review): electron-builder strips `build` from the packaged
  // package.json, so the worker reads `repository`. The packaged copy must still name this version's release.
  const asar = require('@electron/asar');
  const { releaseBaseUrl } = await import('../core/cuda-pack.mts');
  const packagedPkg = JSON.parse(asar.extractFile(path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar'), 'package.json').toString('utf8'));
  const committedPkg = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const expectedRelease = `https://github.com/JLSkyzer/openagenticskyzer/releases/download/v${committedPkg.version}/`;
  assert.equal(packagedPkg.version, committedPkg.version, 'the packaged package.json is this version');
  assert.equal(releaseBaseUrl(packagedPkg), expectedRelease, `the packaged package.json names the release (keys: ${Object.keys(packagedPkg).join(', ')})`);
  process.stdout.write(`packaged package.json: repository ${JSON.stringify(packagedPkg.repository)} -> ${expectedRelease}\n`);
  const userData = await mkdtemp(join(tmpdir(), 'openagent-package-userdata-'));
  const openagentHome = await mkdtemp(join(tmpdir(), 'openagent-package-home-'));
  const port = 9334;
  // A loopback port that was just freed refuses connections: the updater runs for real and fails,
  // without any network access. (Not port 9: Chromium's net stack blocks it as ERR_UNSAFE_PORT
  // before any socket is opened, which would prove nothing about the feed.)
  const closedPort = await freeLoopbackPort();
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      OPENAGENT_HOME: openagentHome,
      OPENAGENT_UPDATE_FEED: `http://127.0.0.1:${closedPort}/`,
      OPENAGENT_UPDATE_CHECK_DELAY_MS: '200',
    },
  });
  try {
    const version = await waitFor(() => httpGetJson(`http://127.0.0.1:${port}/json/version`));
    assert.match(version.Browser, /Chrome/, 'a real Chromium instance answered the debug port');
    assert.match(
      version['User-Agent'],
      /Electron\/44\.4\.2/,
      'the packaged exe really is Electron 44.4.2 (Tâche 12), not a stale build',
    );

    // The /json title starts as the URL's filename and only becomes the real <title>
    // once the page has actually parsed — poll for that, not just "a page exists".
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    });
    assert.equal(pages[0].title, 'openagent', 'the real window title loaded');
    assert.match(
      pages[0].url,
      /app\.asar[\\/]renderer-dist[\\/]index\.html$/,
      'loaded from the packaged asar bundle, not a dev server or loose files',
    );

    const { cdpEvaluate, waitFor: waitForCdp } = require('./cdp-helper.cjs');
    const status = await waitForCdp(async () => {
      const value = await cdpEvaluate(pages[0].webSocketDebuggerUrl, "window.openagent.request({ op: 'update-status' })");
      return value && value.status === 'error' ? value : null;
    }, { timeout: 20000, what: 'the packaged updater reports its (expected) connection failure' });
    process.stdout.write(`updater status observed: ${JSON.stringify(status)}\n`);
    assert.equal(status.enabled, true, 'updates are active in the packaged app');
    assert.doesNotMatch(status.message, /Cannot find module/, 'electron-updater and its dependencies are packaged');
    assert.match(status.message, /ECONNREFUSED|ERR_CONNECTION_REFUSED|connect|127\.0\.0\.1/, 'the updater really ran against the feed');
    assert.equal(status.packaged, true, 'the status says the app is packaged (Réglages never calls it a dev build)');

    // "Redémarrer maintenant" with no downloaded update: the real main.cjs refuses it before touching the worker,
    // which still answers afterwards.
    const refusal = await cdpEvaluate(pages[0].webSocketDebuggerUrl, "window.openagent.request({ op: 'update-install-now' }).then(() => 'resolved', error => error.message)");
    assert.match(refusal, /Aucune mise à jour prête à installer/, 'install-now without a ready update is refused');
    const folders = await cdpEvaluate(pages[0].webSocketDebuggerUrl, "window.openagent.request({ op: 'list_folders' })");
    assert.ok(Array.isArray(folders), 'the worker still answers after the refused install');
    process.stdout.write(`install-now refused: ${JSON.stringify(refusal)}; worker answered list_folders (${folders.length} folder(s))\n`);

    // The data folder explains itself (core/data-folders.mts, packaged through core/**): the worker answers only once
    // its start-up is done, so the isolated home (OPENAGENT_HOME, no redirect: it IS the data home) now holds
    // LISEZMOI.txt and the knowledge/, tools/ and logs/ folders. Checked before knowledge-add, which would create
    // knowledge/ by itself.
    const readme = await readFile(join(openagentHome, 'LISEZMOI.txt'), 'utf8');
    assert.match(readme, /^Dossier de données d’openagent\. Ce fichier est régénéré à chaque démarrage/, 'LISEZMOI.txt was written by the packaged worker');
    for (const name of ['knowledge', 'tools', 'logs']) assert.ok((await stat(join(openagentHome, name))).isDirectory(), `${name}/ was created at start`);
    process.stdout.write('data home at start: LISEZMOI.txt, knowledge/, tools/ and logs/ present\n');

    // A real offline embedding inside the packaged app: knowledge-add reads and embeds a temporary .md with the bundled
    // model (workerData.modelsDir = <resources>/models), and nothing is downloaded or cached in the data home.
    const note = join(openagentHome, 'smoke-note.md');
    await writeFile(note, '# Note\n\nTrier une liste de nombres avec un tri rapide.\n');
    const added = await cdpEvaluate(pages[0].webSocketDebuggerUrl, `window.openagent.request({ op: 'knowledge-add', payload: { filePath: ${JSON.stringify(note)} } }).then(r => ({ ok: true, r }), e => ({ ok: false, e: String(e.message || e) }))`);
    assert.equal(added.ok, true, `knowledge-add: ${JSON.stringify(added)}`);
    assert.ok(added.r.chunks >= 1, `knowledge-add embedded at least one chunk: ${JSON.stringify(added.r)}`);
    await assert.rejects(stat(join(openagentHome, 'embeddings-cache')), { code: 'ENOENT' }, 'no embeddings cache is created in the data home');
    process.stdout.write(`knowledge-add in the packaged app: ${JSON.stringify(added.r)}; no embeddings-cache in the data home\n`);

    // The « 🖥️ Matériel » tab in the packaged app: the worker's hardware-info reaches the page in French. The line is
    // absent until the first answer (the tab renders no line before it), so its text can only come from the worker.
    const page = pages[0].webSocketDebuggerUrl;
    await cdpEvaluate(page, "document.getElementById('oa-settings-btn').click()");
    await waitForCdp(() => cdpEvaluate(page, `!!document.querySelector('[data-testid="oa-settings-tab"][data-tab="hardware"]')`), { timeout: 10000, what: 'the Matériel tab exists' });
    await cdpEvaluate(page, `document.querySelector('[data-testid="oa-settings-tab"][data-tab="hardware"]').click()`);
    const backendLine = await waitForCdp(async () => {
      const value = await cdpEvaluate(page, `document.querySelector('[data-testid="oa-hardware-line"][data-field="backend"]')?.textContent ?? null`);
      return /^Moteur : (CUDA|Vulkan|Metal|processeur seul)$/.test(value ?? '') ? value : null;
    }, { timeout: 120000, what: 'the Matériel tab shows the engine backend' });
    process.stdout.write(`Matériel tab in the packaged app: ${JSON.stringify(backendLine)}\n`);

    // The packaged worker offers the CUDA pack: its shipped manifest and its release source are both valid, so the
    // state is 'absent' with the download size (never 'unavailable', what the stripped `build` now gives).
    const pack = await cdpEvaluate(page, "window.openagent.request({ op: 'cuda-pack-status' })");
    assert.equal(pack.state, 'absent', `cuda-pack-status in the packaged app: ${JSON.stringify(pack)}`);
    assert.ok(pack.downloadBytes > 0, 'the download size is known before any download');
    process.stdout.write(`cuda-pack-status in the packaged app: ${JSON.stringify(pack)}\n`);

    process.stdout.write('PASS packaged executable launches outside npm start and loads the real UI\n');
  } finally {
    child.kill();
    await rm(userData, { recursive: true, force: true }).catch(() => {});
    await rm(openagentHome, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL package smoke: ${error.stack || error}\n`);
  process.exitCode = 1;
});
