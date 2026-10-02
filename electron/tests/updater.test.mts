import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('feedOverride accepts only http loopback URLs, normalised with a trailing slash', () => {
  const { feedOverride } = require('../updater.cjs');
  assert.equal(feedOverride('http://127.0.0.1:8123'), 'http://127.0.0.1:8123/');
  assert.equal(feedOverride('http://localhost:9000/feed'), 'http://localhost:9000/feed/');
  assert.equal(feedOverride('http://127.0.0.1:8123/feed/'), 'http://127.0.0.1:8123/feed/');
  for (const bad of ['https://127.0.0.1:8123/', 'http://example.com/', 'http://127.0.0.2/', 'http://localhost.evil.com/', 'file:///C:/x', 'not a url', '', undefined, 42]) {
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
  assert.deepEqual(updater.status(), { enabled: false, currentVersion: '0.2.0', status: 'idle', at: null });
  assert.deepEqual(await updater.check(), { enabled: false, currentVersion: '0.2.0', status: 'idle', at: null }, 'check is a no-op, never loads electron-updater');
  assert.throws(() => updater.installNow(), /Aucune mise à jour prête à installer/);
  assert.deepEqual(sent, []);
});
