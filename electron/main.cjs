const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { homedir } = require('node:os');
const { Worker } = require('node:worker_threads');

let mainWindow;
let backend;
let connections;
const pending = new Map();
const allowed = new Set(['global-settings','project-settings','save-global-settings','save-project-settings','list-branches','messages','save-messages','fork','list_folders','activate_folder','settings','save_settings','send','stop']);

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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

async function createConnections() {
  const { Connections } = await import('./core/connections.mts');
  return new Connections({ home: path.join(homedir(), '.openagent'), cipher: safeStorage, environment: process.env });
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

ipcMain.handle('backend-request', async (event, request) => {
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
});

if (require.main === module) {
  app.whenReady().then(async () => { connections = await createConnections(); createWindow(); startBackend(); });
  app.on('window-all-closed', () => { backend?.terminate(); if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { resolveSendPayload, createConnections };
