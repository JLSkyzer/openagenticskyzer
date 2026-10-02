// Plain Node script — NOT run through the Electron binary like the other *-visual.cjs
// tests. Spawns the PACKAGED executable (release/win-unpacked/openagent.exe) exactly
// how a real user would launch it (never via npm start / node), and proves it opens a
// real window with the real UI entirely outside the dev/test harness.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
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
