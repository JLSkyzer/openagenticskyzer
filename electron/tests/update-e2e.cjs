// Proves the update path of the PACKAGED app, end to end, WITHOUT installing anything.
//   1. builds the current version (release/) and the next patch version (release-next/),
//      never touching package.json;
//   2. serves release-next/ on 127.0.0.1 (random port) as an update feed;
//   3. launches release/win-unpacked/openagent.exe pointed at that feed, waits until the
//      real updater has found, downloaded and verified the next version, checks the real
//      banner, and checks the downloaded file's SHA-512 against latest.yml;
//   4. kills the app (TerminateProcess: no `quit` event, so nothing is installed).
// The one-time real install/update/uninstall proof is tests/install-e2e.cjs.
const { spawnSync, spawn } = require('node:child_process');
const { readFileSync, createReadStream, existsSync, statSync } = require('node:fs');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { waitFor, waitForPage, cdpEvaluate } = require('./cdp-helper.cjs');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const current = pkg.version;
const next = current.replace(/(\d+)$/, patch => String(Number(patch) + 1)); // 0.2.0 → 0.2.1
function build(extra) {
  const vite = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'renderer-src/vite.config.mts'], { cwd: ROOT, stdio: 'inherit' });
  if (vite.status !== 0) throw new Error('renderer build failed');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'never', ...extra], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`electron-builder failed (${extra.join(' ')})`);
}

const CDP_PORT = 9336;
const NEXT_DIR = path.join(ROOT, 'release-next');
const INSTALLER = `openagent-Setup-${next}.exe`;

// Static file server for release-next/: only the three files an update needs, with Content-Length
// (and Range, which electron-updater's differential download may ask for); 404 otherwise.
function startFeedServer() {
  const allowed = new Set(['latest.yml', INSTALLER, `${INSTALLER}.blockmap`]);
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url || '').split('?')[0]));
    const file = path.join(NEXT_DIR, name);
    if (!allowed.has(name) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Type': 'application/octet-stream' });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// The expected SHA-512 is the top-level `sha512:` line of latest.yml (the per-file ones are indented).
async function expectedSha512() {
  const yml = await readFile(path.join(NEXT_DIR, 'latest.yml'), 'utf8');
  const match = /^sha512:\s*(\S+)\s*$/m.exec(yml);
  assert.ok(match, 'release-next/latest.yml has a top-level sha512 line');
  assert.match(yml, new RegExp(`^version:\\s*${next.replace(/\./g, '\\.')}\\s*$`, 'm'), 'latest.yml announces the next version');
  return match[1];
}

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('base64')));
  });
}

async function main() {
  // N in release/, N+1 in release-next/ — never touches package.json.
  build([]);
  build([`-c.extraMetadata.version=${next}`, '-c.directories.output=release-next']);

  const exePath = path.join(ROOT, 'release', 'win-unpacked', 'openagent.exe');
  assert.ok(existsSync(exePath), 'the packaged exe was built');
  const appUpdate = readFileSync(path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
  const cacheDirName = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(appUpdate)?.[1];
  assert.ok(cacheDirName, 'app-update.yml names the updater cache directory');
  // electron-updater also drops files next to `pending` (e.g. current.blockmap): if the cache root is ours, remove all of it.
  const cacheRoot = path.join(process.env.LOCALAPPDATA, cacheDirName);
  const cacheRootExisted = existsSync(cacheRoot);
  const pendingDir = path.join(cacheRoot, 'pending');
  const pendingExisted = existsSync(pendingDir);
  const expected = await expectedSha512();

  const { server, port } = await startFeedServer();
  const userData = await mkdtemp(path.join(tmpdir(), 'openagent-update-userdata-'));
  const openagentHome = await mkdtemp(path.join(tmpdir(), 'openagent-update-home-'));
  const child = spawn(exePath, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: {
      ...process.env,
      OPENAGENT_HOME: openagentHome,
      OPENAGENT_USERDATA_DIR: userData,
      OPENAGENT_SKIP_ONBOARDING: '1',
      OPENAGENT_UPDATE_FEED: `http://127.0.0.1:${port}/`,
      OPENAGENT_UPDATE_CHECK_DELAY_MS: '500',
    },
  });
  try {
    const page = await waitForPage(CDP_PORT);
    let last = '';
    const status = await waitFor(async () => {
      const value = await cdpEvaluate(page.webSocketDebuggerUrl, "window.openagent.request({ op: 'update-status' })");
      const line = `${value.status}${value.percent != null ? ` ${Math.round(value.percent)}%` : ''}${value.message ? ` (${value.message})` : ''}`;
      if (line !== last && value.status !== 'downloading') { process.stdout.write(`updater: ${line}\n`); last = line; }
      return value.status === 'ready' || value.status === 'error' ? value : null; // waitFor swallows throws: return the error state instead
    }, { timeout: 5 * 60 * 1000, interval: 1000, what: 'the packaged updater reaches "ready" (full download)' });
    assert.notEqual(status.status, 'error', `the updater reported an error: ${status.message}`);
    assert.equal(status.enabled, true, 'updates are active in the packaged app');
    assert.equal(status.currentVersion, current, 'the packaged app is the current version');
    assert.equal(status.version, next, 'the updater found the next version');

    const banner = await cdpEvaluate(page.webSocketDebuggerUrl, "document.querySelector('[data-testid=\"oa-update-banner\"]')?.textContent ?? null");
    assert.ok(banner && banner.includes(next), `the real banner shows v${next} (got ${JSON.stringify(banner)})`);

    const downloaded = path.join(pendingDir, INSTALLER);
    assert.ok(existsSync(downloaded), `the verified installer sits in the updater cache: ${downloaded}`);
    assert.equal(await sha512Base64(downloaded), expected, 'the downloaded installer matches the SHA-512 in latest.yml');

    process.stdout.write(`PASS update e2e: packaged v${current} found v${next} on a local feed, downloaded and verified it (sha512), banner shown — not installed\n`);
  } finally {
    child.kill(); // TerminateProcess: no `quit` event, so nothing installs
    await new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    server.close();
    for (const dir of [userData, openagentHome]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    if (!cacheRootExisted) await rm(cacheRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    else if (!pendingExisted) await rm(pendingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL update e2e: ${error.stack || error}\n`);
  process.exitCode = 1;
});
