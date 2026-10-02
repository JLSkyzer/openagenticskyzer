import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

test('every test that launches the packaged exe switches updates off, except the three updater tests', async () => {
  // Otherwise each run asks production GitHub; once a newer release exists, the run would download it into
  // the real %LOCALAPPDATA%\openagent-desktop-updater and install it when the app closes gracefully.
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const RUN_THE_UPDATER = ['package-smoke.cjs', 'update-e2e.cjs', 'install-e2e.cjs']; // loopback feed or refused port
  const launchers: string[] = [];
  const missing: string[] = [];
  for (const name of (await readdir(dir)).filter(file => /\.(c|m)?[jt]s$/.test(file)).sort()) {
    const source = await readFile(`${dir}${name}`, 'utf8');
    if (!/win-unpacked|openagent\.exe/.test(source) || RUN_THE_UPDATER.includes(name)) continue;
    if (name === 'updater.test.mts') continue; // this guard names the exe itself
    launchers.push(name);
    if (!/OPENAGENT_DISABLE_UPDATES:\s*'1'/.test(source)) missing.push(name);
  }
  assert.ok(launchers.includes('bridge-real.cjs') && launchers.includes('final-e2e.cjs'), `the scan found the launchers (${launchers.join(', ')})`);
  assert.deepEqual(missing, [], 'packaged-exe launchers that would query production GitHub');
});

test('feedOverride accepts only http loopback URLs, normalised with a trailing slash', () => {
  const { feedOverride } = require('../updater.cjs');
  assert.equal(feedOverride('http://127.0.0.1:8123'), 'http://127.0.0.1:8123/');
  assert.equal(feedOverride('http://localhost:9000/feed'), 'http://localhost:9000/feed/');
  assert.equal(feedOverride('http://127.0.0.1:8123/feed/'), 'http://127.0.0.1:8123/feed/');
  for (const bad of ['https://127.0.0.1:8123/', 'http://example.com/', 'http://127.0.0.2/', 'http://localhost.evil.com/', 'http://127.0.0.1/feed?x', 'http://127.0.0.1/feed#f', 'http://a@127.0.0.1/', 'http://a:b@localhost/', 'file:///C:/x', 'not a url', '', undefined, 42]) {
    assert.equal(feedOverride(bad), null, String(bad));
  }
});

test('updates are enabled only in the packaged app, and can be switched off', () => {
  const { updatesEnabled } = require('../updater.cjs');
  assert.equal(updatesEnabled({ isPackaged: true, env: {} }), true);
  assert.equal(updatesEnabled({ isPackaged: false, env: {} }), false);
  assert.equal(updatesEnabled({ isPackaged: false, env: { OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:1/' } }), false, 'a feed never enables a dev build');
  assert.equal(updatesEnabled({ isPackaged: true, env: { OPENAGENT_DISABLE_UPDATES: '1' } }), false);
});

test('the first-check delay is 10 s, and only a loopback feed may shorten it', () => {
  const { checkDelayMs } = require('../updater.cjs');
  assert.equal(checkDelayMs({}), 10000);
  assert.equal(checkDelayMs({ OPENAGENT_UPDATE_CHECK_DELAY_MS: '500' }), 10000, 'ignored without a feed override');
  assert.equal(checkDelayMs({ OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:1/', OPENAGENT_UPDATE_CHECK_DELAY_MS: '500' }), 500);
  assert.equal(checkDelayMs({ OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:1/', OPENAGENT_UPDATE_CHECK_DELAY_MS: 'abc' }), 10000);
  assert.equal(checkDelayMs({ OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:1/', OPENAGENT_UPDATE_CHECK_DELAY_MS: '' }), 10000, 'empty is not 0');
});

test('install-now is allowed only for a ready update', () => {
  const { canInstallNow } = require('../updater.cjs');
  assert.equal(canInstallNow({ status: 'ready', version: '1.0.0' }), true);
  for (const status of ['idle', 'checking', 'available', 'downloading', 'up-to-date', 'error']) assert.equal(canInstallNow({ status }), false);
  assert.equal(canInstallNow(null), false);
});

test('a disabled updater reports itself disabled and refuses to install', async () => {
  const { createUpdater } = require('../updater.cjs');
  const sent: unknown[] = [];
  const updater = createUpdater({ app: { isPackaged: false, getVersion: () => '0.2.0' }, send: (s: unknown) => sent.push(s), env: {} });
  updater.start();
  assert.deepEqual(updater.status(), { enabled: false, packaged: false, currentVersion: '0.2.0', status: 'idle', at: null });
  assert.deepEqual(await updater.check(), { enabled: false, packaged: false, currentVersion: '0.2.0', status: 'idle', at: null }, 'check is a no-op, never loads electron-updater');
  assert.throws(() => updater.installNow(), /Aucune mise à jour prête à installer/);
  assert.deepEqual(sent, []);
});

test('the status says whether the app is packaged, so a switched-off packaged app is not called a dev build', async () => {
  const { createUpdater } = require('../updater.cjs');
  const app = { isPackaged: true, getVersion: () => '0.2.0' };
  const off = createUpdater({ app, send: () => {}, env: { OPENAGENT_DISABLE_UPDATES: '1' } });
  assert.deepEqual(await off.check(), { enabled: false, packaged: true, currentVersion: '0.2.0', status: 'idle', at: null });
  const on = createUpdater({ app, send: () => {}, env: {} });
  assert.deepEqual(on.status(), { enabled: true, packaged: true, currentVersion: '0.2.0', status: 'idle', at: null });
  assert.throws(() => on.installNow(), /Aucune mise à jour prête à installer/, 'refused before electron-updater is even loaded');
});

// createInstallNow is tested with real async functions that record what ran and when — its collaborators are
// main.cjs's stopBackend/startBackend and updater.installNow, which cannot run here without installing.
function recorder() {
  const log: string[] = [];
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  return {
    log,
    stop: async () => { log.push('stop:start'); await pause(60); log.push('stop:end'); },
    restart: () => { log.push('restart'); },
  };
}

test('install-now stops the worker completely before the installer starts', async () => {
  const { createInstallNow } = require('../updater.cjs');
  const r = recorder();
  const installNow = createInstallNow({ canInstall: () => true, stop: r.stop, restart: r.restart, install: () => { r.log.push('install'); return { installing: true }; } });
  assert.deepEqual(await installNow(), { installing: true });
  assert.deepEqual(r.log, ['stop:start', 'stop:end', 'install']);
});

test('install-now without a ready update is refused before anything stops', async () => {
  const { createInstallNow } = require('../updater.cjs');
  const r = recorder();
  const installNow = createInstallNow({ canInstall: () => false, stop: r.stop, restart: r.restart, install: () => { r.log.push('install'); } });
  await assert.rejects(installNow(), /Aucune mise à jour prête à installer/);
  assert.deepEqual(r.log, [], 'the worker was never touched');
});

test('an installer that cannot start brings the worker back, and the error reaches the caller', async () => {
  const { createInstallNow } = require('../updater.cjs');
  const r = recorder();
  let attempts = 0;
  const installNow = createInstallNow({
    canInstall: () => true, stop: r.stop, restart: r.restart,
    install: () => { r.log.push('install'); if (++attempts === 1) throw new Error('installeur introuvable'); return { installing: true }; },
  });
  await assert.rejects(installNow(), /installeur introuvable/);
  assert.deepEqual(r.log, ['stop:start', 'stop:end', 'install', 'restart']);
  assert.deepEqual(await installNow(), { installing: true }, 'a failed attempt does not block a retry');
});

test('a restart that fails too does not hide why the install failed', async () => {
  const { createInstallNow } = require('../updater.cjs');
  const installNow = createInstallNow({
    canInstall: () => true, stop: async () => {}, restart: () => { throw new Error('worker HS'); },
    install: () => { throw new Error('installeur introuvable'); },
  });
  await assert.rejects(installNow(), /installeur introuvable/);
});

test('a second click while the worker is stopping does not start a second shutdown or an early installer', async () => {
  const { createInstallNow } = require('../updater.cjs');
  const r = recorder();
  const installNow = createInstallNow({ canInstall: () => true, stop: r.stop, restart: r.restart, install: () => { r.log.push('install'); return { installing: true }; } });
  const [first, second] = await Promise.all([installNow(), installNow()]);
  assert.deepEqual(first, { installing: true });
  assert.deepEqual(second, { installing: true });
  assert.deepEqual(r.log, ['stop:start', 'stop:end', 'install']);
});

test('a downloaded update is never re-checked, so it stays installable', () => {
  const { shouldCheck, canInstallNow } = require('../updater.cjs');
  assert.equal(shouldCheck({ status: 'ready', version: '1.0.0' }), false);
  for (const status of ['idle', 'checking', 'available', 'downloading', 'up-to-date', 'error']) assert.equal(shouldCheck({ status }), true, status);
  assert.equal(shouldCheck(null), true);
  assert.equal(canInstallNow({ status: 'ready' }), true);
});
