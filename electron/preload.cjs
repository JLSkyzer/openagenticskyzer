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
});
