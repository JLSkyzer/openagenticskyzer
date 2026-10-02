// Installs openagent on THIS machine, updates it, uninstalls it. Never run by the normal suite — only on explicit
// request (`npm run test:install`). Flow: silent-install version N, launch the INSTALLED exe against a local feed
// serving N+1, click the real "Redémarrer maintenant" button, wait for the in-place update, relaunch to confirm
// N+1, then silent-uninstall and verify nothing is left (folder, HKCU entry, shortcuts).
const { spawnSync, spawn } = require('node:child_process');
const { readFileSync, createReadStream, existsSync, statSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
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

const NEXT_DIR = path.join(ROOT, 'release-next');
const SETUP_CURRENT = path.join(ROOT, 'release', `openagent-Setup-${current}.exe`);
const INSTALLER_NEXT = `openagent-Setup-${next}.exe`;
const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'openagent');
const installedExe = path.join(installDir, 'openagent.exe');
const uninstaller = path.join(installDir, 'Uninstall openagent.exe');
const startMenuShortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'openagent.lnk');

// Static file server for release-next/ (latest.yml, the next installer and its blockmap): Content-Length, 404 otherwise.
function startFeedServer() {
  const allowed = new Set(['latest.yml', INSTALLER_NEXT, `${INSTALLER_NEXT}.blockmap`]);
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

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

// The HKCU uninstall entry whose DisplayName is exactly `openagent`: { key, version } or null.
function uninstallEntry() {
  const search = run('reg', ['query', UNINSTALL_ROOT, '/s', '/f', 'openagent', '/d']);
  let key = null;
  for (const line of search.out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) key = line.trim();
    else if (key && /^\s*DisplayName\s+REG_SZ\s+openagent\s*$/.test(line)) {
      const version = /^\s*DisplayVersion\s+REG_SZ\s+(\S+)\s*$/m.exec(run('reg', ['query', key, '/v', 'DisplayVersion']).out);
      return { key, version: version ? version[1] : null };
    }
  }
  return null;
}

// Image-name filter that cannot see foreign processes: only the executables living under the folder we installed.
function installedProcessIds() {
  const script = `Get-Process openagent -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${installDir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }`;
  return run('powershell', ['-NoProfile', '-Command', script]).out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
}
function killInstalledProcesses() {
  for (const pid of installedProcessIds()) run('taskkill', ['/PID', pid, '/T', '/F']);
}
function installerProcessRunning() {
  const script = "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'openagent-Setup*' -or $_.ProcessName -like 'Un_A*' -or $_.ProcessName -like 'Uninstall openagent*' } | ForEach-Object { $_.Id }";
  return /\d/.test(run('powershell', ['-NoProfile', '-Command', script]).out);
}

function launchInstalled(cdpPort, userData, openagentHome, extraEnv) {
  return spawn(installedExe, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`], {
    stdio: 'ignore',
    env: { ...process.env, OPENAGENT_HOME: openagentHome, OPENAGENT_USERDATA_DIR: userData, OPENAGENT_SKIP_ONBOARDING: '1', ...extraEnv },
  });
}
function exited(child) {
  return new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
}
const removeDir = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});

async function main() {
  // Guard first: never touch an existing installation.
  if (existsSync(installDir) || uninstallEntry()) {
    process.stdout.write("SKIP: openagent est déjà installé — test annulé pour ne pas toucher à ton installation\n");
    process.exitCode = 1;
    return;
  }
  const desktop = run('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"]).out.trim();
  assert.ok(desktop && existsSync(desktop), `resolved the Desktop folder (${desktop})`);
  const desktopShortcut = path.join(desktop, 'openagent.lnk');
  assert.ok(!existsSync(desktopShortcut) && !existsSync(startMenuShortcut), 'no openagent shortcut exists before the test (would make the cleanup check meaningless)');

  // N in release/, N+1 in release-next/ — never touches package.json.
  build([]);
  build([`-c.extraMetadata.version=${next}`, '-c.directories.output=release-next']);
  assert.ok(existsSync(SETUP_CURRENT), `built ${SETUP_CURRENT}`);

  const updaterCacheDirName = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(readFileSync(path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app-update.yml'), 'utf8'))?.[1];
  assert.ok(updaterCacheDirName, 'app-update.yml names the updater cache directory');
  // electron-updater also drops files next to `pending` (e.g. current.blockmap): if the cache root is ours, remove all of it.
  const cacheRoot = path.join(process.env.LOCALAPPDATA, updaterCacheDirName);
  const cacheRootExisted = existsSync(cacheRoot);
  const pendingDir = path.join(cacheRoot, 'pending');
  const pendingExisted = existsSync(pendingDir);

  const temps = [];
  let server = null;
  let installStarted = false;
  let failure = null;
  try {
    // 3. Install N, silently.
    installStarted = true;
    run(SETUP_CURRENT, ['/S']);
    await waitFor(() => existsSync(installedExe) && uninstallEntry()?.version === current, { timeout: 120000, interval: 1000, what: `openagent v${current} installed (exe + HKCU DisplayVersion)` });
    await waitFor(() => !installerProcessRunning(), { timeout: 60000, interval: 1000, what: 'the installer process finished' });
    killInstalledProcesses(); // a silent install must not leave the app running; make sure before driving it
    assert.ok(existsSync(desktopShortcut), `Desktop shortcut exists: ${desktopShortcut}`);
    assert.ok(existsSync(startMenuShortcut), `Start menu shortcut exists: ${startMenuShortcut}`);
    process.stdout.write(`installed v${current} in ${installDir}, shortcuts present\n`);

    // 4. Launch the INSTALLED exe against the local feed; click the real button.
    const started = await startFeedServer();
    server = started.server;
    const userData = await mkdtemp(path.join(tmpdir(), 'openagent-install-userdata-'));
    const openagentHome = await mkdtemp(path.join(tmpdir(), 'openagent-install-home-'));
    temps.push(userData, openagentHome);
    const first = launchInstalled(9337, userData, openagentHome, {
      OPENAGENT_UPDATE_FEED: `http://127.0.0.1:${started.port}/`,
      OPENAGENT_UPDATE_CHECK_DELAY_MS: '500',
      OPENAGENT_UPDATE_NO_RELAUNCH: '1',
    });
    const page = await waitForPage(9337);
    const ready = await waitFor(async () => {
      const value = await cdpEvaluate(page.webSocketDebuggerUrl, "window.openagent.request({ op: 'update-status' })");
      return value.status === 'ready' || value.status === 'error' ? value : null;
    }, { timeout: 5 * 60 * 1000, interval: 1000, what: 'the installed app downloads the update' });
    assert.notEqual(ready.status, 'error', `the updater reported an error: ${ready.message}`);
    assert.equal(ready.currentVersion, current, 'the installed app is the current version');
    assert.equal(ready.version, next, 'the installed app found the next version');
    process.stdout.write(`update v${next} downloaded; clicking "Redémarrer maintenant"\n`);
    await cdpEvaluate(page.webSocketDebuggerUrl, "document.querySelector('#oa-update-install').click(), true");

    // 5. The app quits, the installer updates in place, nothing relaunches (NO_RELAUNCH).
    await Promise.race([
      exited(first),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the app did not exit after clicking install')), 120000)),
    ]);
    await waitFor(() => uninstallEntry()?.version === next, { timeout: 180000, interval: 1000, what: `HKCU DisplayVersion becomes ${next}` });
    await waitFor(() => !installerProcessRunning(), { timeout: 60000, interval: 1000, what: 'the update installer finished' });
    killInstalledProcesses();
    process.stdout.write(`updated in place to v${next}\n`);

    const second = launchInstalled(9338, userData, openagentHome, {});
    try {
      const page2 = await waitForPage(9338);
      const status = await cdpEvaluate(page2.webSocketDebuggerUrl, "window.openagent.request({ op: 'update-status' })");
      assert.equal(status.currentVersion, next, 'the relaunched installed app reports the new version');
    } finally {
      second.kill();
      await exited(second);
      killInstalledProcesses();
    }

    // 6. Uninstall, silently, and check nothing is left.
    killInstalledProcesses();
    run(uninstaller, ['/S']);
    await waitFor(
      () => !existsSync(installDir) && !uninstallEntry() && !existsSync(desktopShortcut) && !existsSync(startMenuShortcut),
      { timeout: 120000, interval: 1000, what: 'uninstall removed the folder, the HKCU entry and both shortcuts' },
    );
    installStarted = false;
    process.stdout.write(`PASS install e2e: installed v${current}, updated in place to v${next} from the banner, uninstalled cleanly (folder, HKCU entry, shortcuts)\n`);
  } catch (error) {
    failure = error;
  } finally {
    // On any failure, still try to leave the machine as we found it, and say exactly what is left.
    if (server) server.close();
    killInstalledProcesses();
    if (installStarted && (existsSync(installDir) || uninstallEntry())) {
      if (existsSync(uninstaller)) run(uninstaller, ['/S']);
      await waitFor(() => !existsSync(installDir) && !uninstallEntry(), { timeout: 120000, interval: 1000, what: 'cleanup uninstall' }).catch(() => {});
    }
    for (const dir of temps) await removeDir(dir);
    if (!cacheRootExisted) await removeDir(cacheRoot);
    else if (!pendingExisted) await removeDir(pendingDir);
    if (installStarted || failure) {
      const left = [
        existsSync(installDir) && `folder ${installDir}`,
        uninstallEntry() && 'HKCU uninstall entry',
        existsSync(desktopShortcut) && `shortcut ${desktopShortcut}`,
        existsSync(startMenuShortcut) && `shortcut ${startMenuShortcut}`,
        !cacheRootExisted && existsSync(cacheRoot) && `updater cache ${cacheRoot}`,
      ].filter(Boolean);
      process.stdout.write(left.length ? `LEFT BEHIND: ${left.join('; ')}\n` : 'cleanup verified: nothing left behind\n');
    }
  }
  if (failure) throw failure;
}

main().catch(error => {
  process.stderr.write(`FAIL install e2e: ${error.stack || error}\n`);
  process.exitCode = 1;
});
