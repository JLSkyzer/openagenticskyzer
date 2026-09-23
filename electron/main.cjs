const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, session } = require('electron');
const path = require('node:path');
const { homedir } = require('node:os');
const { Worker } = require('node:worker_threads');

let mainWindow;
let backend;
let connections;
const pending = new Map();
const allowed = new Set(['global-settings','project-settings','save-global-settings','save-project-settings','list-branches','messages','save-messages','fork','list_folders','activate_folder','settings','save_settings','send','stop','permission-decision','clear-history','remove-folder','reset-global-settings','compact','list-prompts','read-project-memory','export-conversation']);

// Exactly the pattern core/export.mts::exportFilename generates — never a filename supplied as-is
// by the renderer. Constrains what "open-export" (below) is allowed to open, whatever the folder.
const EXPORT_FILENAME = /^conversation_\d{8}_\d{6}\.(md|html|json)$/;
const isExportFilename = name => typeof name === 'string' && EXPORT_FILENAME.test(name);

// Operations that call the model: main.cjs folds the resolved connection (including the API key,
// which the page never sees) into their payload. Everything else must never receive it.
const CONNECTION_OPS = new Set(['send', 'compact']);
const isBackendOp = op => allowed.has(op);
const needsConnection = op => CONNECTION_OPS.has(op);

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
  backend.on('message', message => {
    const done = pending.get(message.id);
    if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
    // The window may already be gone while the worker is still shutting down.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-message', message);
  });
  backend.on('error', error => { for (const item of pending.values()) item.reject(error); pending.clear(); });
}

/**
 * Asks the worker to shut down (it aborts running work and stops the dev servers that
 * run_command started, whole process trees included), waits for its answer for a short grace
 * period, then terminates the thread. Terminating alone would leave those servers running.
 */
async function stopWorker(worker, timeoutMs = 3000) {
  if (!worker) return;
  const id = `shutdown-${Date.now()}`;
  let listener;
  const answered = new Promise(resolve => {
    listener = message => { if (message && message.id === id) resolve(); };
    worker.on('message', listener);
  });
  try {
    worker.postMessage({ op: 'shutdown', id });
    let timer;
    await Promise.race([answered, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  } finally {
    worker.off?.('message', listener);
    await worker.terminate();
  }
}
async function stopBackend() {
  const worker = backend;
  backend = undefined;
  await stopWorker(worker);
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
  if (request.op === 'open-export') {
    const { folder, filename } = request.payload || {};
    if (!isExportFilename(filename)) throw new Error('Nom de fichier d’export invalide');
    if (typeof folder !== 'string' || !folder) throw new Error('Dossier invalide');
    const error = await shell.openPath(path.join(folder, filename));
    if (error) throw new Error(error);
    return { opened: true };
  }
  if (!allowed.has(request.op)) throw new Error('Opération IPC inconnue');
  if (!backend) throw new Error('Moteur Node indisponible');
  if (needsConnection(request.op)) request = await resolveSendPayload(connections, request);
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
  // Whatever way the app quits, the worker is shut down properly first so no dev server outlives it.
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    stopBackend().finally(() => app.quit());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { resolveSendPayload, createConnections, buildCsp, chooseLoadTarget, handleBackendRequest, stopWorker, isBackendOp, needsConnection, isExportFilename };
