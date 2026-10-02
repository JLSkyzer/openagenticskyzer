// Automatic updates from GitHub Releases (electron-updater + NSIS). Pure helpers are exported for
// tests; electron-updater itself is required lazily, so a dev build or a test never loads it.

const FIRST_CHECK_MS = 10000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** OPENAGENT_UPDATE_FEED (tests only): honoured solely for an http URL on this machine. */
function feedOverride(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return null;
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function updatesEnabled({ isPackaged, env }) {
  return Boolean(isPackaged) && env.OPENAGENT_DISABLE_UPDATES !== '1';
}

/** First-check delay; only a test pointed at a loopback feed may shorten it. */
function checkDelayMs(env) {
  if (!feedOverride(env.OPENAGENT_UPDATE_FEED)) return FIRST_CHECK_MS;
  const value = Number(env.OPENAGENT_UPDATE_CHECK_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : FIRST_CHECK_MS;
}

function canInstallNow(status) {
  return status?.status === 'ready';
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 300);
}

/**
 * The app's updater. `send(status)` pushes every status change to the renderer. Nothing restarts
 * the app except installNow(), which the user triggers; otherwise a downloaded update installs at quit.
 */
function createUpdater({ app, send, env = process.env }) {
  const enabled = updatesEnabled({ isPackaged: app.isPackaged, env });
  let last = { status: 'idle', at: null };
  let autoUpdater = null;

  const status = () => ({ enabled, currentVersion: app.getVersion(), ...last });
  const publish = next => {
    last = { ...next, at: new Date().toISOString() };
    send(status());
  };

  function load() {
    if (autoUpdater) return autoUpdater;
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = {
      info: message => console.log('[updater]', message),
      warn: message => console.warn('[updater]', message),
      error: message => console.error('[updater]', message),
      debug: () => {},
    };
    const feed = feedOverride(env.OPENAGENT_UPDATE_FEED);
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }));
    autoUpdater.on('update-available', info => publish({ status: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => publish({ status: 'up-to-date' }));
    autoUpdater.on('download-progress', progress => publish({ status: 'downloading', percent: Math.round(progress.percent) }));
    autoUpdater.on('update-downloaded', info => publish({ status: 'ready', version: info.version }));
    autoUpdater.on('error', error => publish({ status: 'error', message: errorMessage(error) }));
    return autoUpdater;
  }

  async function check() {
    if (!enabled) return status();
    try {
      await load().checkForUpdates();
    } catch (error) {
      publish({ status: 'error', message: errorMessage(error) });
    }
    return status();
  }

  function start() {
    if (!enabled) return;
    setTimeout(() => { void check(); }, checkDelayMs(env)).unref?.();
    setInterval(() => { void check(); }, INTERVAL_MS).unref?.();
  }

  function installNow() {
    if (!canInstallNow(last)) throw new Error('Aucune mise à jour prête à installer');
    // Test-only: the one-time install test must never relaunch an app outside its isolated data.
    const relaunch = !(feedOverride(env.OPENAGENT_UPDATE_FEED) && env.OPENAGENT_UPDATE_NO_RELAUNCH === '1');
    load().quitAndInstall(true, relaunch);
    return { installing: true };
  }

  return { start, check, installNow, status };
}

module.exports = { feedOverride, updatesEnabled, checkDelayMs, canInstallNow, createUpdater };
