// Plain Node script. Final end-to-end proof for parity row 1 (« fermer envoie dans la zone de notification »): spawns
// the REAL packaged executable (real main.cjs, real worker, real tray icon) on an isolated data home and drives the
// window the way Windows does — WM_CLOSE is what the title-bar cross sends. What it proves:
//   - the cross HIDES the window: the process, the worker and the page keep running;
//   - launching the app again shows the hidden window (main.cjs's 'second-instance' handler is showMainWindow, the
//     very function behind the tray's « Ouvrir openagent »);
//   - CDP Browser.close — Electron's Browser::Quit, the same quit as the app.quit() behind the tray's « Quitter » and
//     electron-updater's quitAndInstall — really ends the process, exit code 0;
//   - a Windows session end (WM_QUERYENDSESSION, then WM_ENDSESSION) ends it too.
// The native tray menu cannot be clicked from here: tray-icon.test.mts proves which function each item calls.
// Every Win32 message is posted only to a window owned by the test's own app process (checked by PID right before
// the post), never to any other window. Every window here is opened ONCE; on failure the output is reported,
// nothing is retried.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WM_CLOSE = 0x0010;
const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
// user32 from PowerShell 5.1. The here-string's closing '@ must start its line.
const USER32 = `Add-Type -Namespace OA -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
`;

/** Runs a PowerShell script (passed encoded: no quoting issue) and resolves with its trimmed output. */
function powershell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', reject);
    ps.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell exit ${code}: ${err.trim()}`))));
  });
}
const mainWindowHandle = pid => powershell(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`).then(Number);
const isVisible = hwnd => powershell(`${USER32}[OA.U]::IsWindowVisible([System.IntPtr]::new(${hwnd}))`).then(out => out === 'True');
/** Posts a message to `hwnd` only if that window belongs to process `pid` (the test's own app); throws otherwise. */
const post = (pid, hwnd, message, wParam = 0) => powershell(`${USER32}$owner = [uint32]0
[void][OA.U]::GetWindowThreadProcessId([System.IntPtr]::new(${hwnd}), [ref]$owner)
if ($owner -ne ${pid}) { [Console]::Error.WriteLine("window ${hwnd} belongs to process $owner, not to the test's app ${pid}: nothing posted"); exit 3 }
[void][OA.U]::PostMessage([System.IntPtr]::new(${hwnd}), ${message}, [System.IntPtr]::new(${wParam}), [System.IntPtr]::Zero)`);

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where the log is written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const root = await mkdtemp(join(tmpdir(), 'openagent-tray-'));
  const home = join(root, 'home');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(userData)]);
  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  // OPENAGENT_USERDATA_DIR makes main.cjs key its single-instance lock on this temp folder: every launch below shares
  // the lock with each other and never with a real running openagent.
  const env = { ...process.env, OPENAGENT_HOME: home, OPENAGENT_USERDATA_DIR: userData, OPENAGENT_DISABLE_UPDATES: '1' };
  const childOutput = [];
  const running = new Set();
  let debugPort = 9860;

  function spawnApp(extraArgs) {
    const child = spawn(exePath, [...extraArgs, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => childOutput.push(`[stdout ${child.pid}] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr ${child.pid}] ${d}`));
    const instance = { child, exited: false, cdp: null, port: null, hwnd: 0 };
    instance.exitPromise = new Promise(resolve => child.on('exit', code => { instance.exited = true; running.delete(instance); resolve(code); }));
    running.add(instance);
    return instance;
  }
  async function launch() {
    const port = debugPort++;
    const instance = spawnApp([`--remote-debugging-port=${port}`]);
    instance.port = port;
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000, what: 'the packaged app page' });
    instance.cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await instance.cdp.send('Runtime.enable');
    await waitFor(() => instance.cdp.evaluate(`document.body.textContent.includes('Ouvre un dossier pour commencer')`), { timeout: 15000, what: 'the interface is rendered' });
    instance.hwnd = await waitFor(() => mainWindowHandle(instance.child.pid), { timeout: 10000, what: 'the app window handle' });
    return instance;
  }
  const exitWithin = (instance, ms) => Promise.race([instance.exitPromise, sleep(ms).then(() => 'timeout')]);
  const workerAnswers = async instance => Array.isArray(await instance.cdp.evaluate(`window.openagent.request({ op: 'list_folders' })`, true));

  let app;
  try {
    app = await launch();
    assert.equal(await isVisible(app.hwnd), true, 'the window starts visible');
    record(`PROOF 1 — packaged app launched (pid=${app.child.pid}), window ${app.hwnd} visible`);

    await post(app.child.pid, app.hwnd, WM_CLOSE);
    await waitFor(async () => !(await isVisible(app.hwnd)), { timeout: 10000, what: 'the window hidden after WM_CLOSE' });
    await sleep(1500);
    assert.equal(app.exited, false, 'the process is still running after the cross');
    assert.equal(await workerAnswers(app), true, 'the worker still answers (list_folders) with the window hidden');
    const pagesWhileHidden = await httpGetJson(`http://127.0.0.1:${app.port}/json`);
    assert.ok(pagesWhileHidden.some(page => page.type === 'page' && page.title === 'openagent'), 'the page is still alive');
    record('PROOF 2 — WM_CLOSE (the cross) hid the window; process, worker and page still alive');

    const second = spawnApp([]);
    assert.equal(await exitWithin(second, 15000), 0, 'the second launch hands off and exits with code 0');
    await waitFor(() => isVisible(app.hwnd), { timeout: 10000, what: 'the hidden window shown again by the second launch' });
    assert.equal(app.exited, false);
    record('PROOF 3 — a second launch exited (code 0) and showed the hidden window again (showMainWindow, the tray « Ouvrir » function)');

    app.cdp.close();
    const version = await httpGetJson(`http://127.0.0.1:${app.port}/json/version`);
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    await browser.send('Browser.close').catch(() => {});
    assert.equal(await exitWithin(app, 20000), 0, 'Browser.close (= app.quit, the tray « Quitter » path) ends the process with code 0');
    record('PROOF 4 — Browser.close (Browser::Quit = app.quit) closed the window for real: exit code 0');

    const third = await launch();
    third.cdp.close();
    await post(third.child.pid, third.hwnd, WM_QUERYENDSESSION, 0);
    await post(third.child.pid, third.hwnd, WM_ENDSESSION, 1);
    assert.equal(await exitWithin(third, 10000), 0, 'a Windows session end ends the app, code 0');
    record('PROOF 5 — WM_QUERYENDSESSION + WM_ENDSESSION (Windows session end) ended the app: exit code 0');

    await writeFile(join(proofDir, 'tray-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of close-to-tray on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e tray: ${error.stack || error}\n`);
  process.exitCode = 1;
});
