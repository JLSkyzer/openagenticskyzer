# Windows Installer and Automatic Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship openagent as a per-user Windows NSIS installer that updates itself from GitHub Releases (downloaded in the background, installed only after the user clicks or at quit), with a release script that uploads to a GitHub draft.

**Architecture:** A small main-process module `electron/updater.cjs` wraps `electron-updater` (pure, unit-tested helpers + thin event wiring), exposed to the renderer through three main-handled ops and one preload subscription; a banner (`UpdateBanner.tsx`) and a "Mises à jour" block in Settings › Général show the state. `electron/package.json` switches the target to `nsis`, adds a GitHub `draft` publish config and ships `electron-updater` plus every runtime dependency in `build.files`. `electron/scripts/release-win.cjs` builds and uploads a draft. Real packaged tests drive the built exe over Chrome DevTools Protocol.

**Tech Stack:** Electron 44.4.2, electron-builder 26.15.3, electron-updater ^6.8.9, NSIS, React 19, Node 24 (global `WebSocket`), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-installer-updates-design.md`

## Global Constraints

- Per-user install, no admin: NSIS `oneClick: true`, `perMachine: false`, Start menu + desktop shortcuts, `deleteAppDataOnUninstall: false`. User data is never removed by uninstall.
- Artifact name `openagent-Setup-${version}.${ext}`; files produced: the installer, its `.blockmap`, `latest.yml`.
- `electron-updater` is a runtime **dependency**, and it AND every one of its runtime dependencies are listed explicitly in `build.files` (electron-builder silently drops anything not listed); `updater.cjs` is added to `build.files` too. Both are proven by loading them from the PACKAGED app.
- Publish: GitHub `JLSkyzer/openagenticskyzer`, `releaseType: draft`. The script never publishes a release. The GitHub token is read with `gh auth token`, passed only in the electron-builder process environment as `GH_TOKEN`, never written to disk, printed or logged.
- Updates active only in the packaged app (`app.isPackaged`). `autoDownload: true`, `autoInstallOnAppQuit: true`, `allowDowngrade: false`, `allowPrerelease: false`. First check 10 s after the window opens, then every 6 h. Nothing restarts without a click.
- Statuses: `idle`, `checking`, `available {version}`, `downloading {percent}`, `ready {version}`, `up-to-date`, `error {message}`; every status object carries `enabled`, `currentVersion`, `at` (ISO date or null).
- Main-handled ops: `update-status`, `update-check`, `update-install-now` (`update-install-now` refused with `Aucune mise à jour prête à installer` unless the status is `ready`). Preload: `onUpdateStatus(callback) → unsubscribe`, channel `update-status`.
- Banner: « Version X prête — [Redémarrer maintenant] [Plus tard] »; « Redémarrer maintenant » disabled during an agent turn with « après le tour en cours »; « Plus tard » hides it for the session. Settings › Général: installed version, « Vérifier les mises à jour », last result with its date; non-packaged: « Mises à jour désactivées (version de développement) ».
- Errors never block the app and never open an error window.
- Test-only environment variables:
  - `OPENAGENT_UPDATE_FEED` — switches to a `generic` feed ONLY for `http://127.0.0.1[:port]/…` or `http://localhost[:port]/…`; anything else is ignored.
  - Rulings made while writing this plan (the spec names only the feed variable): `OPENAGENT_UPDATE_CHECK_DELAY_MS` (first-check delay) and `OPENAGENT_UPDATE_NO_RELAUNCH=1` (install without relaunching, so the one-time install test never starts an unisolated app) are honoured ONLY when a valid loopback `OPENAGENT_UPDATE_FEED` is set; `OPENAGENT_DISABLE_UPDATES=1` turns the updater off entirely (for packaged-app tests that must not reach GitHub).
- Ruling made while writing this plan: the release script's "uncommitted changes" refusal checks the `electron/` subtree only (the spec said "dans `electron/` et la racine"), because the repository root carries the user's unrelated, uncommitted Python work-in-progress that does not go into the build — checking it would block every release.
- No mocks: real Electron windows, real packaged exe, real HTTP servers, real `git`/`gh`. The one-time real install test is a separate npm script NEVER run by the normal suite.
- Out of scope: code signing (env `CSC_LINK`/`CSC_KEY_PASSWORD` left for later), macOS/Linux, CI, prerelease channel, publishing the draft.

---

### Task 1: `updater.cjs` — helpers, wiring, main process and preload integration

**Files:**
- Create: `electron/updater.cjs`
- Create: `electron/tests/updater.test.mts`
- Modify: `electron/main.cjs` (require at top; `let updater;`; three ops in `handleBackendRequest` before the `allowed` check; create + start in `app.whenReady`)
- Modify: `electron/preload.cjs` (add `onUpdateStatus`)
- Modify: `electron/tests/main-routing.test.mts` (line 11: add the three ops to `HANDLED_BY_MAIN`)
- Modify: `electron/tests/all.mts` (register `updater.test.mts`)

**Interfaces:**
- Produces (`updater.cjs`, CommonJS): `feedOverride(value: unknown): string | null`; `updatesEnabled({ isPackaged, env }): boolean`; `canInstallNow(status): boolean`; `checkDelayMs(env): number`; `createUpdater({ app, send, env }) → { start(), check(): Promise<Status>, installNow(): { installing: true }, status(): Status }` where `Status = { enabled: boolean, currentVersion: string, status: string, version?: string, percent?: number, message?: string, at: string | null }`.
- Produces (main ops): `update-status` → `Status`; `update-check` → `Promise<Status>`; `update-install-now` → `{ installing: true }` or throws `Aucune mise à jour prête à installer`.
- Produces (preload): `window.openagent.onUpdateStatus(callback: (status: Status) => void): () => void`.

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/updater.test.mts`:

```typescript
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
```

In `electron/tests/main-routing.test.mts`, line 11, add `'update-status', 'update-check', 'update-install-now'` to the `HANDLED_BY_MAIN` array. Register the new file in `electron/tests/all.mts` (last line): `import './updater.test.mts';`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/updater.test.mts`
Expected: FAIL — `Cannot find module '../updater.cjs'`.

- [ ] **Step 3: Implement `electron/updater.cjs`**

```javascript
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
```

- [ ] **Step 4: Wire `main.cjs` and `preload.cjs`**

In `electron/main.cjs`, after `const { buildDiamondIconPng } = require('./tray-icon.cjs');` add:

```javascript
const { createUpdater } = require('./updater.cjs');
```

After `let connections;` add `let updater;`. In `handleBackendRequest`, right after the `artifact-put` line and BEFORE `if (!allowed.has(request.op)) …`, add:

```javascript
  // Updates live in the main process (electron-updater must run there); the worker never sees them.
  if (request.op === 'update-status') {
    return updater ? updater.status() : { enabled: false, currentVersion: app.getVersion(), status: 'idle', at: null };
  }
  if (request.op === 'update-check') {
    if (!updater) throw new Error('Mises à jour indisponibles');
    return updater.check();
  }
  if (request.op === 'update-install-now') {
    if (!updater) throw new Error('Aucune mise à jour prête à installer');
    return updater.installNow();
  }
```

In `app.whenReady().then(async () => { … })`, right after `createWindow();` add:

```javascript
      updater = createUpdater({
        app,
        send: status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status); },
      });
      updater.start();
```

(`installNow` → `quitAndInstall` → `app.quit()`: the existing `before-quit` handler shuts the worker down first, exactly like a normal quit — keep it unchanged.)

In `electron/preload.cjs`, inside the object passed to `exposeInMainWorld`, after `onIndexEvent`, add:

```javascript
  // Update statuses come from the main process on their own channel (never the worker's).
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
```

- [ ] **Step 5: Run the tests**

Run: `cd electron && node --experimental-strip-types --test tests/updater.test.mts tests/main-routing.test.mts`
Expected: all PASS.

- [ ] **Step 6: Type-check and commit**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json` — only the 5 pre-existing errors (local-engine.mts, local-provider.mts, pdf-loader.ts, local-provider.test.mts ×2).

```bash
cd electron
git add updater.cjs main.cjs preload.cjs tests/updater.test.mts tests/main-routing.test.mts tests/all.mts
git commit -m "feat: main-process updater around electron-updater, exposed as three main ops and a preload subscription"
```

---

### Task 2: Renderer — update banner and Settings › Général block, real Electron UI test

**Files:**
- Modify: `electron/renderer-src/src/ipc/types.ts` (`UpdateStatus`; `onUpdateStatus` in `OpenAgentBridge`)
- Modify: `electron/renderer-src/src/ipc/bridge.ts` (4 functions)
- Create: `electron/renderer-src/src/components/UpdateBanner.tsx`
- Modify: `electron/renderer-src/src/components/ChatView.tsx` (render `<UpdateBanner />` right after `<ProjectTrustBanner />`)
- Modify: `electron/renderer-src/src/components/settings/GeneralTab.tsx` (new "Mises à jour" section, last in the tab)
- Create: `electron/tests/update-visual.cjs`, `electron/tests/run-update-visual.cjs`
- Modify: `electron/package.json` (script `test:update-ui`)

**Interfaces:**
- Consumes (Task 1): ops `update-status`, `update-check`, `update-install-now`; preload `onUpdateStatus`.
- Produces (DOM ids for later tests): `[data-testid="oa-update-banner"]`, `#oa-update-install`, `#oa-update-later`, `[data-testid="oa-update-after-turn"]`, `[data-testid="oa-update-state"]` (with `data-status`), `#oa-update-check`, `[data-testid="oa-update-version"]`.

- [ ] **Step 1: Types and bridge**

In `electron/renderer-src/src/ipc/types.ts`, before `export interface OpenAgentBridge`, add:

```typescript
export interface UpdateStatus {
  enabled: boolean;
  currentVersion: string;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  at: string | null;
}
```

and inside `OpenAgentBridge` add `onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;`.

In `electron/renderer-src/src/ipc/bridge.ts`, after `onIndexEvent`, add (importing/re-exporting `UpdateStatus` the way the file already handles types from `./types`):

```typescript
export function getUpdateStatus(): Promise<UpdateStatus> {
  return request('update-status');
}
export function checkForUpdates(): Promise<UpdateStatus> {
  return request('update-check');
}
export function installUpdateNow(): Promise<{ installing: boolean }> {
  return request('update-install-now');
}
export function onUpdateStatus(callback: (status: UpdateStatus) => void): () => void {
  return window.openagent.onUpdateStatus(callback);
}
```

- [ ] **Step 2: Banner**

Create `electron/renderer-src/src/components/UpdateBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getUpdateStatus, installUpdateNow, onUpdateStatus, type UpdateStatus } from '../ipc/bridge';
import { useChat } from '../state/ChatProvider';
import { useToast } from '../state/ToastProvider';

// "Plus tard" hides the banner for the rest of the session — module-level so a chat remount
// (folder switch, cleared history) does not bring it back.
let dismissedVersion: string | null = null;

/** Shown once an update is downloaded. Nothing restarts without a click; otherwise it installs at quit. */
export function UpdateBanner() {
  const { state } = useChat();
  const { notify } = useToast();
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [, setTick] = useState(0);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let alive = true;
    getUpdateStatus().then(status => { if (alive) setUpdate(status); }).catch(() => {});
    const off = onUpdateStatus(status => setUpdate(status));
    return () => { alive = false; off(); };
  }, []);

  if (!update || update.status !== 'ready' || !update.version || dismissedVersion === update.version) return null;

  const install = async () => {
    setInstalling(true);
    try {
      await installUpdateNow();
    } catch (error) {
      setInstalling(false);
      notify(error instanceof Error ? error.message : 'Installation impossible.', 'negative');
    }
  };
  const later = () => {
    dismissedVersion = update.version ?? null;
    setTick(tick => tick + 1);
  };

  return (
    <div data-testid="oa-update-banner" className="mx-6 my-2 flex items-center gap-3 rounded-lg border border-blue-800 px-3 py-2 text-xs" style={{ background: '#0a1220' }}>
      <span className="text-blue-300">Version {update.version} prête.</span>
      <button
        id="oa-update-install"
        disabled={state.agentRunning || installing}
        onClick={() => void install()}
        className="rounded bg-blue-700 px-3 py-1 font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {installing ? 'Redémarrage…' : 'Redémarrer maintenant'}
      </button>
      {state.agentRunning && <span data-testid="oa-update-after-turn" className="text-gray-400">après le tour en cours</span>}
      <button id="oa-update-later" onClick={later} className="rounded bg-gray-700 px-3 py-1 text-white hover:bg-gray-800">
        Plus tard
      </button>
    </div>
  );
}
```

In `ChatView.tsx`, import it next to `ProjectTrustBanner` and render `<UpdateBanner />` on the line right after `<ProjectTrustBanner />`.

- [ ] **Step 3: Settings › Général**

In `GeneralTab.tsx`, merge `useEffect` into the existing `react` import and `checkForUpdates, getUpdateStatus, onUpdateStatus, type UpdateStatus` into the existing `../../ipc/bridge` import. Add this helper at module level (above the component):

```tsx
function updateText(update: UpdateStatus): string {
  if (!update.enabled) return 'Mises à jour désactivées (version de développement)';
  switch (update.status) {
    case 'idle': return 'Pas encore vérifié';
    case 'checking': return 'Vérification…';
    case 'available': return `Version ${update.version} disponible — téléchargement…`;
    case 'downloading': return `Téléchargement : ${update.percent ?? 0} %`;
    case 'ready': return `Version ${update.version} prête — elle s’installera à la fermeture`;
    case 'up-to-date': return 'À jour';
    case 'error': return `Échec : ${update.message ?? 'erreur inconnue'}`;
  }
}
```

Inside the component, after the existing state hooks:

```tsx
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let alive = true;
    getUpdateStatus().then(status => { if (alive) setUpdate(status); }).catch(() => {});
    const off = onUpdateStatus(status => setUpdate(status));
    return () => { alive = false; off(); };
  }, []);
  const runCheck = async () => {
    setChecking(true);
    try { setUpdate(await checkForUpdates()); }
    catch (error) { notify(error instanceof Error ? error.message : 'Vérification impossible.', 'negative'); }
    finally { setChecking(false); }
  };
```

Then, as the LAST child of the tab's root `<div className="flex flex-col gap-5">`, add:

```tsx
      <div>
        <Section title="Mises à jour" />
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3 text-xs">
            <span className="text-gray-300">
              Version installée : <span data-testid="oa-update-version" className="font-mono">{update?.currentVersion ?? '…'}</span>
            </span>
            {update && (
              <span data-testid="oa-update-state" data-status={update.enabled ? update.status : 'disabled'} className="text-gray-500">
                {updateText(update)}
                {update.at && ` (${new Date(update.at).toLocaleString('fr-FR')})`}
              </span>
            )}
            <button
              id="oa-update-check"
              onClick={() => void runCheck()}
              disabled={checking || !update?.enabled}
              className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}
            >
              {checking ? 'Vérification…' : 'Vérifier les mises à jour'}
            </button>
          </div>
        </Group>
      </div>
```

Run: `cd electron && npx tsc --noEmit -p renderer-src/tsconfig.json && npm run renderer:build` — 0 errors, build succeeds.

- [ ] **Step 4: Real Electron UI test**

Create `electron/tests/update-visual.cjs` from the bootstrap of `electron/tests/chat-visual.cjs` (read it first): REAL `worker.mjs` behind `ipcMain.handle('backend-request', …)`, a fake OpenAI-compatible model server, the `connection` injected into `send` (chat-visual line ~85), `win.loadFile(renderer-dist/index.html)`, its `js`/`click`/`exists`/`text`/`waitFor` helpers, a seeded `folders.json` with one folder, `capturePng`. Differences:
- the fake model answers every request after **3 s** (`setTimeout(() => response.end(...), 3000)`) with a plain final answer, so a turn stays visibly running;
- the `backend-request` handler answers the three update ops itself — as the real main process does — from a `status` the test controls, BEFORE forwarding anything else to the worker:

```javascript
    let status = { enabled: true, currentVersion: '0.2.0', status: 'idle', at: null };
    let checks = 0;
    let installs = 0;
    const pushStatus = next => { status = { ...status, ...next, at: new Date().toISOString() }; win.webContents.send('update-status', status); };
    // in ipcMain.handle('backend-request', (_event, request) => { … }):
    if (request.op === 'update-status') return status;
    if (request.op === 'update-check') { checks++; pushStatus({ status: 'up-to-date' }); return status; }
    if (request.op === 'update-install-now') {
      if (status.status !== 'ready') throw new Error('Aucune mise à jour prête à installer');
      installs++;
      return { installing: true };
    }
```

Scenario (assert each step; screenshots `update-1-banner.png`, `update-2-settings.png` into `process.env.OPENAGENT_UPDATE_SCREENSHOT_DIR || home`):
1. Enter the folder. `[data-testid="oa-update-banner"]` absent (status idle).
2. `pushStatus({ status: 'ready', version: '0.3.0' })` → banner appears, text contains `0.3.0`, `#oa-update-install` enabled.
3. Type a message and send it (as chat-visual does); while the turn runs assert `#oa-update-install` is disabled and `[data-testid="oa-update-after-turn"]` exists; after the turn ends assert it is enabled again and the after-turn mention is gone.
4. Click `#oa-update-install` → `installs === 1`.
5. Click `#oa-update-later` → banner gone; `pushStatus({ status: 'ready', version: '0.3.0' })` again → still gone (dismissed for the session).
6. Open settings (`#oa-settings-btn`), Général tab (`[data-testid="oa-settings-tab"][data-tab="general"]`): `[data-testid="oa-update-version"]` shows `0.2.0`; `[data-testid="oa-update-state"]` has `data-status="ready"`; click `#oa-update-check` → `checks === 1` and `data-status` becomes `up-to-date`.
7. Print `PASS update UI: banner, disabled during a turn, install/later, settings check through the real renderer (Electron ${process.versions.electron})`.

Create `electron/tests/run-update-visual.cjs` exactly like `run-trust-visual.cjs` but spawning `update-visual.cjs` and requiring `PASS update UI` in stdout. Add `"test:update-ui": "node tests/run-update-visual.cjs",` to `electron/package.json` scripts.

Run: `cd electron && npm run test:update-ui` → PASS; look at both screenshots.

- [ ] **Step 5: Regressions and commit**

Run: `cd electron && node --experimental-strip-types --test tests/main-routing.test.mts tests/updater.test.mts && npm run test:trust`
Expected: PASS (main-routing now sees the bridge sending the three ops, all in `HANDLED_BY_MAIN`).

```bash
cd electron
git add renderer-src/src/ipc/types.ts renderer-src/src/ipc/bridge.ts renderer-src/src/components/UpdateBanner.tsx renderer-src/src/components/ChatView.tsx renderer-src/src/components/settings/GeneralTab.tsx tests/update-visual.cjs tests/run-update-visual.cjs package.json
git commit -m "feat: update banner and Settings › Général block, proven in a real Electron window"
```

---

### Task 3: Packaging — NSIS target, publish config, electron-updater shipped, release script

**Files:**
- Modify: `electron/package.json` (`dependencies`, `build.win`, `build.nsis`, `build.publish`, `build.files`, scripts `package:win`, `release:win`)
- Modify: `electron/package-lock.json` (via `npm install`)
- Create: `electron/scripts/release-win.cjs`
- Create: `electron/tests/release-win.test.mts`
- Create: `electron/tests/cdp-helper.cjs`
- Modify: `electron/tests/package-smoke.cjs` (prove the updater module runs in the packaged app)
- Modify: `electron/tests/all.mts` (register `release-win.test.mts`)
- Modify: `.gitignore` (repo root: add `electron/release-next/`)

**Interfaces:**
- Produces (`scripts/release-win.cjs`): `assertReleasable({ version, dirty, exists })` (throws), `isTreeDirty(cwd): boolean`, `releaseExists(version, repo?): boolean`; CLI `node scripts/release-win.cjs [--dry-run] [--root <dir>]`.
- Produces (`tests/cdp-helper.cjs`): `httpGetJson(url)`, `waitFor(fn, { timeout, interval, what })`, `waitForPage(port, title = 'openagent', timeout = 30000)` → the `/json` page entry (with `webSocketDebuggerUrl`), `cdpEvaluate(webSocketDebuggerUrl, expression)`.
- Produces (build): `release/openagent-Setup-<version>.exe`, `release/openagent-Setup-<version>.exe.blockmap`, `release/latest.yml`, `release/win-unpacked/resources/app-update.yml`.

- [ ] **Step 1: Install and list electron-updater's runtime tree**

Run: `cd electron && npm install electron-updater@^6.8.9 --save`
Then: `npm ls electron-updater --omit=dev --all --parseable` and record every directory under `node_modules/` it prints (expected roughly electron-updater, builder-util-runtime, debug, ms, sax, fs-extra, graceful-fs, jsonfile, universalify, js-yaml, argparse, lazy-val, lodash.escaperegexp, lodash.isequal, semver, tiny-typed-emitter — the printed list is authoritative, not this one).

- [ ] **Step 2: Write the failing tests**

Create `electron/tests/release-win.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('../scripts/release-win.cjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ghReady = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;

async function cleanRepo(t: any, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('assertReleasable refuses a dirty tree, an existing release and an invalid version', () => {
  const { assertReleasable } = require(SCRIPT);
  assert.doesNotThrow(() => assertReleasable({ version: '0.3.0', dirty: false, exists: false }));
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: true, exists: false }), /non commités/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, exists: true }), /existe déjà/);
  assert.throws(() => assertReleasable({ version: 'abc', dirty: false, exists: false }), /Version invalide/);
});

test('isTreeDirty reads the real git state of the given folder', async t => {
  const { isTreeDirty } = require(SCRIPT);
  const root = await cleanRepo(t, '0.0.1');
  assert.equal(isTreeDirty(root), false);
  await writeFile(join(root, 'new.txt'), 'x');
  assert.equal(isTreeDirty(root), true);
});

test('releaseExists asks the real GitHub repository', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.equal(releaseExists('0.0.0-never-released', 'JLSkyzer/openagenticskyzer'), false);
});

test('--dry-run checks everything, never prints the token, and refuses a dirty tree', { skip: ghReady ? false : 'gh CLI not authenticated' }, async t => {
  const root = await cleanRepo(t, '0.0.1-dry');
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
  const ok = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /dry-run/);
  assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token never appears');
  await writeFile(join(root, 'dirty.txt'), 'x');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /non commités/);
});
```

Register in `tests/all.mts`: `import './release-win.test.mts';`

Run: `cd electron && node --experimental-strip-types --test tests/release-win.test.mts` → FAIL (script missing).

- [ ] **Step 3: Implement `electron/scripts/release-win.cjs`**

```javascript
// Builds the Windows installer and uploads it to a DRAFT GitHub release. Publishing the draft is
// the user's own gesture. The GitHub token only ever lives in electron-builder's environment.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = 'JLSkyzer/openagenticskyzer';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function assertReleasable({ version, dirty, exists }) {
  if (!SEMVER.test(String(version))) throw new Error(`Version invalide dans package.json : ${version}`);
  if (dirty) throw new Error('Changements non commités dans electron/ : commite-les avant de publier.');
  if (exists) throw new Error(`La release v${version} existe déjà : monte la version dans package.json.`);
}

/** Only the given folder's subtree (electron/): the repo root holds unrelated work in progress. */
function isTreeDirty(cwd) {
  const result = run('git', ['status', '--porcelain', '--', '.'], { cwd });
  if (result.status !== 0) throw new Error(`git status a échoué : ${result.stderr.trim()}`);
  return result.stdout.trim() !== '';
}

function releaseExists(version, repo = REPO) {
  const result = run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'tagName']);
  if (result.status === 0) return true;
  if (/release not found|not found/i.test(result.stderr)) return false;
  throw new Error(`Impossible de vérifier la release sur GitHub : ${result.stderr.trim()}`);
}

function githubToken() {
  const result = run('gh', ['auth', 'token']);
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) throw new Error('Jeton GitHub introuvable : lance `gh auth login`.');
  return token;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : path.join(__dirname, '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertReleasable({ version, dirty: isTreeDirty(root), exists: releaseExists(version) });
  const token = githubToken();
  if (dryRun) {
    process.stdout.write(`dry-run: v${version} publiable en brouillon (jeton GitHub lu, ${token.length} caractères, non affiché)\n`);
    return 0;
  }
  const env = { ...process.env, GH_TOKEN: token };
  const steps = [
    [process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'renderer-src/vite.config.mts']],
    [process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'always']],
  ];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error(`Étape échouée : ${path.basename(args[0])}`);
  }
  process.stdout.write(`Brouillon v${version} déposé sur GitHub : relis-le puis publie-le (https://github.com/${REPO}/releases).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { assertReleasable, isTreeDirty, releaseExists };
```

Run the release tests → PASS.

- [ ] **Step 4: Packaging configuration**

In `electron/package.json`:
- `scripts`: `"package:win": "npm run renderer:build && electron-builder --win nsis --publish never"`, add `"release:win": "node scripts/release-win.cjs"`.
- `build.win`: `{ "target": "nsis" }`.
- add `build.nsis`: `{ "oneClick": true, "perMachine": false, "createDesktopShortcut": true, "createStartMenuShortcut": true, "shortcutName": "openagent", "deleteAppDataOnUninstall": false, "artifactName": "openagent-Setup-${version}.${ext}" }`.
- add `build.publish`: `[{ "provider": "github", "owner": "JLSkyzer", "repo": "openagenticskyzer", "releaseType": "draft" }]`.
- `build.files`: add `"updater.cjs"` next to `"tray-icon.cjs"`, and `"node_modules/<name>/**/*"` for EVERY directory recorded in Step 1 (scoped packages as `node_modules/@scope/name/**/*`).

Root `.gitignore`: add `electron/release-next/` right under `electron/release/`.

- [ ] **Step 5: CDP helper and packaged proof**

Create `electron/tests/cdp-helper.cjs`:

```javascript
// Drives a packaged openagent.exe started with --remote-debugging-port, over Chrome DevTools Protocol
// (Node's global WebSocket). Used by the packaged-app tests only.
const http = require('node:http');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

async function waitFor(fn, { timeout = 15000, interval = 250, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function waitForPage(port, title = 'openagent', timeout = 30000) {
  return waitFor(async () => {
    const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
    return list.find(page => page.type === 'page' && page.title === title) || null;
  }, { timeout, what: `page "${title}" on port ${port}` });
}

let nextId = 1;
async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP connection failed')); });
  const id = nextId++;
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        if (message.error) reject(new Error(message.error.message));
        else if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
        else resolve(message.result.result.value);
      };
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.close();
  }
}

module.exports = { httpGetJson, waitFor, waitForPage, cdpEvaluate };
```

(If Chromium refuses the WebSocket with 403, add `--remote-allow-origins=*` to the exe arguments in the tests.)

In `electron/tests/package-smoke.cjs`, spawn the exe with `env: { ...process.env, OPENAGENT_HOME: <a temp dir created and removed like userData>, OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:9/', OPENAGENT_UPDATE_CHECK_DELAY_MS: '200' }` (port 9 refuses connections). After the existing title/url assertions and before the PASS line, add:

```javascript
    const { cdpEvaluate, waitFor: waitForCdp } = require('./cdp-helper.cjs');
    const status = await waitForCdp(async () => {
      const value = await cdpEvaluate(pages[0].webSocketDebuggerUrl, "window.openagent.request({ op: 'update-status' })");
      return value && value.status === 'error' ? value : null;
    }, { timeout: 20000, what: 'the packaged updater reports its (expected) connection failure' });
    assert.equal(status.enabled, true, 'updates are active in the packaged app');
    assert.doesNotMatch(status.message, /Cannot find module/, 'electron-updater and its dependencies are packaged');
    assert.match(status.message, /ECONNREFUSED|connect|127\.0\.0\.1/, 'the updater really ran against the feed');
```

- [ ] **Step 6: Build and run the packaged proof**

Run: `cd electron && npm run package:win && npm run test:package`
Expected: `release/openagent-Setup-<version>.exe`, `.exe.blockmap`, `release/latest.yml`, `release/win-unpacked/resources/app-update.yml` exist; `PASS packaged executable launches outside npm start and loads the real UI`. If the updater status message is `Cannot find module 'X'`, add `node_modules/X/**/*` to `build.files`, rebuild, rerun (repeat until green; record each addition in the report).

Run: `cd electron && node --experimental-strip-types --test tests/release-win.test.mts tests/updater.test.mts tests/main-routing.test.mts` → PASS. `npx tsc --noEmit -p tsconfig.core.json` → 5 pre-existing errors only.

- [ ] **Step 7: Commit**

```bash
cd electron
git add package.json package-lock.json scripts/release-win.cjs tests/release-win.test.mts tests/cdp-helper.cjs tests/package-smoke.cjs tests/all.mts ../.gitignore
git commit -m "feat: per-user NSIS installer, GitHub draft publishing, electron-updater shipped in the package"
```

---

### Task 4: Packaged update proof (no install) and the one-time install test

**Files:**
- Create: `electron/tests/update-e2e.cjs`
- Create: `electron/tests/install-e2e.cjs`
- Modify: `electron/package.json` (scripts `test:update`, `test:install`)

**Interfaces:**
- Consumes: `tests/cdp-helper.cjs` (Task 3); op `update-status` (Task 1); DOM `[data-testid="oa-update-banner"]`, `#oa-update-install` (Task 2); build outputs (Task 3).

- [ ] **Step 1: Build step at the top of both scripts**

Both scripts start with the same code (write it at the top of each file — each must be readable on its own):

```javascript
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
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
// N = current version in release/, N+1 in release-next/ — never touches package.json.
build([]);
build([`-c.extraMetadata.version=${next}`, '-c.directories.output=release-next']);
```

Then a static file server (`node:http`) for `release-next/`: serves `latest.yml`, `openagent-Setup-<next>.exe` and its `.blockmap` with `Content-Length`, 404 otherwise; and the expected SHA-512 read from the top-level `sha512:` line of `release-next/latest.yml`.

- [ ] **Step 2: `tests/update-e2e.cjs` — detection + verified download, stops before install**

1. Read `release/win-unpacked/resources/app-update.yml`, take `updaterCacheDirName`; `pendingDir = path.join(process.env.LOCALAPPDATA, updaterCacheDirName, 'pending')`; remember whether it existed before.
2. Spawn `release/win-unpacked/openagent.exe --remote-debugging-port=9336 --user-data-dir=<temp>` with `env: { ...process.env, OPENAGENT_HOME: <temp>, OPENAGENT_USERDATA_DIR: <temp>, OPENAGENT_SKIP_ONBOARDING: '1', OPENAGENT_UPDATE_FEED: 'http://127.0.0.1:<server port>/', OPENAGENT_UPDATE_CHECK_DELAY_MS: '500' }`.
3. `waitForPage(9336)`; poll `window.openagent.request({ op: 'update-status' })` until `status === 'ready'` (timeout 5 min — full download); assert `version === next`.
4. Assert the real banner: `document.querySelector('[data-testid="oa-update-banner"]')?.textContent` contains `next`.
5. Assert the download: `pendingDir/openagent-Setup-<next>.exe` exists and its SHA-512 (base64) equals the `latest.yml` value.
6. `child.kill()` (TerminateProcess: no `quit` event, so nothing installs); stop the server; remove the temp dirs; remove `pendingDir` only if it did not exist before.
7. Print `PASS update e2e: packaged v${current} found v${next} on a local feed, downloaded and verified it (sha512), banner shown — not installed`.

Add `"test:update": "node tests/update-e2e.cjs",` to scripts. Run it → PASS.

- [ ] **Step 3: `tests/install-e2e.cjs` — real install, update, uninstall (one-time proof)**

Header comment: « Installs openagent on THIS machine, updates it, uninstalls it. Never run by the normal suite — only on explicit request (`npm run test:install`). »

1. Guard: `installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'openagent')`; the uninstall entry is found with `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f openagent /d` and the line `DisplayName    REG_SZ    openagent`. If the folder or the entry exists → print `SKIP: openagent est déjà installé — test annulé pour ne pas toucher à ton installation` and exit 1.
2. Desktop: `powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`; Start menu: `path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'openagent.lnk')`.
3. Install N: `spawnSync(release/openagent-Setup-<current>.exe, ['/S'])`, then `waitFor` the installed `openagent.exe` and the registry `DisplayVersion` = `current` (2 min). Assert both shortcuts exist.
4. Start the `release-next/` server. Launch the INSTALLED exe with `--remote-debugging-port=9337 --user-data-dir=<temp>` and env `OPENAGENT_HOME`, `OPENAGENT_USERDATA_DIR` (temps), `OPENAGENT_SKIP_ONBOARDING=1`, `OPENAGENT_UPDATE_FEED`, `OPENAGENT_UPDATE_CHECK_DELAY_MS=500`, `OPENAGENT_UPDATE_NO_RELAUNCH=1`. Wait for `ready`, then `cdpEvaluate(page.webSocketDebuggerUrl, "document.querySelector('#oa-update-install').click(), true")`.
5. Wait for the app process to exit, then for `DisplayVersion` = `next` (3 min). Relaunch the installed exe (same isolated env, no feed) with `--remote-debugging-port=9338`, assert `update-status.currentVersion === next`, kill it.
6. Uninstall: `"<installDir>\Uninstall openagent.exe" /S`; `waitFor` (2 min): `installDir` gone, uninstall entry gone, both shortcuts gone.
7. Remove the temp dirs and the updater `pending` dir created by the test. Print `PASS install e2e: installed v${current}, updated in place to v${next} from the banner, uninstalled cleanly (folder, HKCU entry, shortcuts)`. On any failure, still attempt the silent uninstall in a `finally` and report exactly what was left behind.

Add `"test:install": "node tests/install-e2e.cjs",` to scripts. DO NOT run it in this task (it runs once, in Task 5).

- [ ] **Step 4: Commit**

```bash
cd electron
git add tests/update-e2e.cjs tests/install-e2e.cjs package.json
git commit -m "test: packaged update proof on a local feed, and the one-time real install/update/uninstall test"
```

---

### Task 5: Final verification, one-time install proof, bilan

**Files:**
- Modify: `tasks/todo.md` (repo root)

- [ ] **Step 1:** `cd electron && grep -c "updater.test.mts\|release-win.test.mts" tests/all.mts` → `2`.
- [ ] **Step 2:** Full suite `node --experimental-strip-types --test tests/all.mts` → all pass (623 before this lot + new); report N/N.
- [ ] **Step 3:** `npx tsc --noEmit -p tsconfig.core.json` (5 pre-existing errors only) and `npx tsc --noEmit -p renderer-src/tsconfig.json` (0).
- [ ] **Step 4:** `npm run package:win && npm run test:package && npm run test:update-ui && npm run test:update && npm run test:trust` → five PASS lines.
- [ ] **Step 5:** ONE-TIME real install proof (user consent recorded in the spec, 2026-10-02): `npm run test:install` → PASS. If it reports SKIP (already installed) or leaves anything behind, stop and report it — never force.
- [ ] **Step 6:** `node scripts/release-win.cjs --dry-run` from `electron/` after committing → it must state `v<version> publiable en brouillon`, or refuse for a real reason (dirty `electron/`, existing release) — report which. Never run the script without `--dry-run`: uploading a draft to GitHub is the user's decision.
- [ ] **Step 7:** Append `### Bilan du lot — installeur Windows et mises à jour (2026-10-02)` to the END of `tasks/todo.md` (French, style of the bilans above): what was delivered (installer settings, update flow, release script), the two plan-writing rulings (dirty check limited to `electron/`; the three extra test-only variables honoured only with a loopback feed), the real test totals and the proofs, the security note (unsigned: SmartScreen warning on first install; update integrity by SHA-512 over HTTPS; update security rests on the `JLSkyzer` GitHub account), how to release (bump `version`, commit, `npm run release:win`, review and publish the draft on GitHub), out-of-scope list.
- [ ] **Step 8:** Commit and push:

```bash
git add tasks/todo.md
git commit -m "docs: bilan for the Windows installer and updates lot"
git push
```
