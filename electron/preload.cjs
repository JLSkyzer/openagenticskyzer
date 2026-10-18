const { contextBridge, ipcRenderer } = require('electron');

// Closed surface: `request` for the existing request/response ops, and a single typed,
// filtered event subscription for agent runs (streaming deltas, tool calls, permission
// requests, ...) — no generic relay of arbitrary backend-message payloads (which also
// carries request/response bookkeeping messages the renderer has no business seeing).
contextBridge.exposeInMainWorld('openagent', {
  request: (request) => ipcRenderer.invoke('backend-request', request),
  onAgentEvent: (callback) => {
    const listener = (_event, message) => {
      if (message?.type === 'event' && message.event === 'agent') callback(message);
    };
    ipcRenderer.on('backend-message', listener);
    return () => ipcRenderer.removeListener('backend-message', listener);
  },
  onIndexEvent: (callback) => {
    const listener = (_event, message) => {
      if (message?.type === 'event' && message.event === 'index') callback(message);
    };
    ipcRenderer.on('backend-message', listener);
    return () => ipcRenderer.removeListener('backend-message', listener);
  },
  // The model a turn runs on and its engine's real window (worker.mjs posts it once per turn).
  onModelEvent: (callback) => {
    const listener = (_event, message) => {
      if (message?.type === 'event' && message.event === 'model') callback(message);
    };
    ipcRenderer.on('backend-message', listener);
    return () => ipcRenderer.removeListener('backend-message', listener);
  },
  // The end of a background offload estimate (worker.mjs, op estimate-model).
  onEstimateEvent: (callback) => {
    const listener = (_event, message) => {
      if (message?.type === 'event' && message.event === 'estimate') callback(message);
    };
    ipcRenderer.on('backend-message', listener);
    return () => ipcRenderer.removeListener('backend-message', listener);
  },
  // Update statuses come from the main process on their own channel (never the worker's).
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
