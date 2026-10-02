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
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + (url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`);
}

function updatesEnabled({ isPackaged, env }) {
  return Boolean(isPackaged) && env.OPENAGENT_DISABLE_UPDATES !== '1';
}

/** First-check delay; only a test pointed at a loopback feed may shorten it. */
function checkDelayMs(env) {
  if (!feedOverride(env.OPENAGENT_UPDATE_FEED)) return FIRST_CHECK_MS;
  const raw = env.OPENAGENT_UPDATE_CHECK_DELAY_MS;
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : FIRST_CHECK_MS;
}

function canInstallNow(status) {
  return status?.status === 'ready';
}

/** A downloaded update is on disk: a later check must not erase "ready" (it would refuse the install). */
function shouldCheck(status) {
  return status?.status !== 'ready';
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 300);
}

const NOT_READY = 'Aucune mise à jour prête à installer';

/**
 * "Redémarrer maintenant". With --updated, the NSIS installer kills every process under the install folder about
 * a second after it starts, so the worker (and the run_command process trees it owns) is first shut down by the
 * same path as a normal quit (`stop`), and only then is the installer started (`install`). Refused before anything
 * stops unless `canInstall()`. If the installer cannot start, the worker is brought back (`restart`) and the error
 * still reaches the caller. A second call while one is in flight gets the same promise, never a second installer.
 */
function createInstallNow({ canInstall, stop, install, restart }) {
  let inFlight = null;
  return function installNow() {
    if (inFlight) return inFlight;
    if (!canInstall()) return Promise.reject(new Error(NOT_READY));
    inFlight = (async () => {
      await stop();
      try {
        return await install();
      } catch (error) {
        try { await restart(); } catch (restartError) { console.error('[updater] worker restart failed:', restartError); }
        throw error;
      }
    })();
    inFlight.catch(() => { inFlight = null; });
    return inFlight;
  };
}

/**
 * The app's updater. `send(status)` pushes every status change to the renderer. Nothing restarts
 * the app except installNow(), which the user triggers; otherwise a downloaded update installs at quit.
 */
function createUpdater({ app, send, env = process.env }) {
  const enabled = updatesEnabled({ isPackaged: app.isPackaged, env });
  let last = { status: 'idle', at: null };
  let autoUpdater = null;

  // `packaged` tells the settings apart: a dev build vs a packaged app with OPENAGENT_DISABLE_UPDATES=1.
  const status = () => ({ enabled, packaged: Boolean(app.isPackaged), currentVersion: app.getVersion(), ...last });
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
    if (!enabled || !shouldCheck(last)) return status();
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
    if (!canInstallNow(last)) throw new Error(NOT_READY);
    // Test-only: the one-time install test must never relaunch an app outside its isolated data.
    const relaunch = !(feedOverride(env.OPENAGENT_UPDATE_FEED) && env.OPENAGENT_UPDATE_NO_RELAUNCH === '1');
    load().quitAndInstall(true, relaunch);
    // quitAndInstall never throws: when the installer cannot start synchronously it emits 'error' (which
    // replaces "ready" above) and does not quit. Report it, so the caller can bring the worker back.
    if (last.status !== 'ready') throw new Error(`Installation impossible : ${last.message ?? 'erreur inconnue'}`);
    return { installing: true };
  }

  return { start, check, installNow, status };
}

module.exports = { feedOverride, updatesEnabled, checkDelayMs, canInstallNow, shouldCheck, createInstallNow, createUpdater, NOT_READY };
