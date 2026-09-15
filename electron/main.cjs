const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, session } = require('electron');
const path = require('node:path');
const { homedir } = require('node:os');
const { Worker } = require('node:worker_threads');

let mainWindow;
let backend;
let connections;
const pending = new Map();
const allowed = new Set(['global-settings','project-settings','save-global-settings','save-project-settings','list-branches','messages','save-messages','fork','list_folders','activate_folder','settings','save_settings','send','stop','permission-decision']);

/**
 * Content-Security-Policy for the renderer. Strict in a packaged build (no eval, no
 * remote origins beyond https:). Relaxed ONLY for the Vite dev server (HMR needs
 * 'unsafe-eval' and a ws:// connection) — and only when the app is NOT packaged, so a
 * packaged build can never end up with the relaxed policy regardless of stray env vars.
 */
function buildCsp(isPackaged) {
  const scriptSrc = isPackaged ? "'self'" : "'self' 'unsafe-eval'";
  const connectSrc = isPackaged ? "'self' https:" : "'self' https: ws://localhost:5173 http://localhost:5173";
  return `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectSrc}; object-src 'none'`;
}

/**
 * Where the renderer loads from: the Vite dev server only when explicitly requested via
 * OPENAGENT_RENDERER_DEV and the app is not packaged; the built output otherwise. A
 * packaged app can never load from the dev server, whatever the env var says.
 */
function chooseLoadTarget({ isPackaged, devFlag }) {
  if (!isPackaged && devFlag === '1') return { mode: 'url', target: 'http://localhost:5173' };
  return { mode: 'file', target: path.join(__dirname, 'renderer-dist', 'index.html') };
}

function installCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(app.isPackaged)] } });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#090c12',
    title: 'openagent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const target = chooseLoadTarget({ isPackaged: app.isPackaged, devFlag: process.env.OPENAGENT_RENDERER_DEV });
  if (target.mode === 'url') mainWindow.loadURL(target.target); else mainWindow.loadFile(target.target);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
}

function startBackend() {
  backend = new Worker(path.join(__dirname, 'worker.mjs'), { type: 'module' });
  backend.on('message', message => { const done = pending.get(message.id); if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); } mainWindow?.webContents.send('backend-message', message); });
  backend.on('error', error => { for (const item of pending.values()) item.reject(error); pending.clear(); });
}

// Mirrors worker.mjs's OPENAGENT_HOME override — lets integration tests point the whole
// data layer at a temp directory instead of the real user's ~/.openagent.
function dataHome() {
  return process.env.OPENAGENT_HOME || path.join(homedir(), '.openagent');
}

async function createConnections() {
  const { Connections } = await import('./core/connections.mts');
  return new Connections({ home: dataHome(), cipher: safeStorage, environment: process.env });
}

/**
 * Resolves the active connection (provider/model/api_key) and folds it into the payload
 * forwarded to the Node worker for a `send` request — the worker needs the plaintext key
 * to call the provider, but the renderer must never see it (only `connection-snapshot`,
 * which is redacted by `Connections.snapshot()`, is renderer-facing). Exported so tests
 * can exercise this exact logic without a real BrowserWindow/Worker.
 */
async function resolveSendPayload(connectionsService, request) {
  const connection = await connectionsService.resolve(request.payload?.folder ?? null);
  return { ...request, payload: { ...request.payload, connection } };
}

async function handleBackendRequest(event, request) {
  if (event.sender !== mainWindow?.webContents || !request || typeof request.op !== 'string') throw new Error('Requête IPC invalide');
  if (request.op === 'open-folder') { const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); return picked.canceled ? null : picked.filePaths[0]; }
  if (request.op === 'connection-snapshot') return connections.snapshot(request.payload?.folder ?? null);
  if (request.op === 'save-connection') return connections.save(request.payload?.folder ?? null, request.payload?.patch, request.payload?.authorization);
  if (!allowed.has(request.op)) throw new Error('Opération IPC inconnue');
  if (!backend) throw new Error('Moteur Node indisponible');
  if (request.op === 'send') request = await resolveSendPayload(connections, request);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Délai IPC dépassé')); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    backend.postMessage({ ...request, id });
  });
}

// Real IPC registration and app lifecycle only run for the actual Electron entry point
// (package.json "main") — never when this module is required as a library by tests,
// which would otherwise crash: require('electron') resolves to a path string (not the
// API object) outside a real Electron process, so ipcMain/app are undefined there.
if (require.main === module) {
  ipcMain.handle('backend-request', handleBackendRequest);
  app.whenReady().then(async () => {
    installCsp();
    connections = await createConnections();
    createWindow();
    startBackend();
  });
  app.on('window-all-closed', () => { backend?.terminate(); if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { resolveSendPayload, createConnections, buildCsp, chooseLoadTarget, handleBackendRequest };
