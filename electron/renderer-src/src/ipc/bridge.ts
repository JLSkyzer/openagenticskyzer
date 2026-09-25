import type {
  AgentEvent,
  Attachment,
  BranchInfo,
  ChatMessage,
  ConnectionPatch,
  ConnectionSnapshot,
  FolderListItem,
  ProjectSettings,
  PromptEntry,
} from './types';

// The only place in the renderer allowed to touch window.openagent directly — every
// component goes through these typed functions instead.
function request<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
  return window.openagent.request({ op, payload }) as Promise<T>;
}

export function sendMessage(
  folder: string | null,
  branchId: string,
  text: string,
  // ✏️ / 🔄: cut the saved history to its first `keep` messages before the turn. Omitted entirely (not
  // sent as undefined/null) for an ordinary send, which the worker reads as "keep everything".
  keep?: number,
  // The message's files, already processed by processUpload. Omitted when there are none.
  attachments?: Attachment[],
): Promise<{ runId: string }> {
  return request('send', {
    folder, branchId, text,
    ...(keep === undefined ? {} : { keep }),
    ...(attachments?.length ? { attachments } : {}),
  });
}

export function stop(runId: string): Promise<{ stopped: boolean }> {
  return request('stop', { runId });
}

export function decidePermission(
  runId: string,
  requestId: string,
  allow: boolean,
  always: boolean,
): Promise<{ ok: boolean }> {
  return request('permission-decision', { runId, requestId, allow, always });
}

export function onAgentEvent(callback: (event: AgentEvent) => void): () => void {
  return window.openagent.onAgentEvent(callback);
}

export interface GlobalSettings {
  theme: 'dark' | 'light';
  accent_color: string;
  [key: string]: unknown;
}

export function getGlobalSettings(): Promise<GlobalSettings> {
  return request('global-settings');
}

// Whatever reads settings or the active connection (the context gauge) must follow a change made
// elsewhere, in the settings dialog or the model dialog. The bridge is the one place every save goes
// through, so it announces them — after success only: a refused save changed nothing.
const settingsListeners = new Set<() => void>();

export function onSettingsChanged(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
}

function announcing<T>(saved: Promise<T>): Promise<T> {
  return saved.then(value => {
    for (const listener of [...settingsListeners]) {
      try { listener(); } catch { /* one faulty listener must not hide the saved result from the caller */ }
    }
    return value;
  });
}

export function saveGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  return announcing(request<GlobalSettings>('save-global-settings', { patch }));
}

export function openFolderDialog(): Promise<string | null> {
  return request('open-folder');
}

export function activateFolder(folder: string): Promise<{ history: ChatMessage[]; folders: FolderListItem[] }> {
  return request('activate_folder', { folder });
}

export function listFolders(): Promise<FolderListItem[]> {
  return request('list_folders');
}

export function getMessages(folder: string, branchId = 'main'): Promise<ChatMessage[]> {
  return request('messages', { folder, branchId });
}

export function listBranches(folder: string): Promise<BranchInfo[]> {
  return request('list-branches', { folder });
}

// `count` is how many messages of `source` the new branch keeps: index of the clicked message + 1.
export function forkBranch(folder: string, source: string, count: number, label: string): Promise<{ id: string; label: string }> {
  return request('fork', { folder, source, count, label });
}

// exporter.py, ported: writes a Markdown/HTML/JSON export of the branch to the project folder. Never
// carries the connection's API key (export.mts doesn't call the model) — model/provider are the
// already-redacted strings the model button shows, not a resolved connection.
export function exportConversation(
  folder: string,
  branchId: string,
  format: 'md' | 'html' | 'json',
  provider: string,
  model: string,
): Promise<{ filename: string }> {
  return request('export-conversation', { folder, branchId, format, provider, model });
}

// Opens the just-exported file with the OS's associated application (os.startfile on Windows,
// shell.openPath cross-platform here). Only main.cjs may do this, and only for a folder + filename
// matching exactly what exportConversation itself just generated.
export function openExportedFile(folder: string, filename: string): Promise<{ opened: boolean }> {
  return request('open-export', { folder, filename });
}

// The side preview of what the model wrote (artifact panel): the document is handed to the main process, which
// serves it on the `oa-artifact:` protocol with its own Content-Security-Policy and answers the URL to frame.
// `kind` 'html' may run its inline script (still with no network at all); 'static' (svg, mermaid) runs nothing.
export function putArtifact(kind: 'html' | 'static', html: string): Promise<{ url: string }> {
  return request('artifact-put', { kind, html });
}

// The prompt library (✦): the defaults or the user's prompts.json, read again on every call so a hand
// edit is seen without restarting.
export function listPrompts(): Promise<PromptEntry[]> {
  return request('list-prompts');
}

// The project's persistent memory, read-only, for the "🧠 Mémoire projet" window. `truncated` means the
// beginning was left out (only the end is kept, where the recent facts are).
export function readProjectMemory(folder: string): Promise<{ content: string; truncated: boolean }> {
  return request('read-project-memory', { folder });
}

// Summarises the branch in the background: the answer is only the id to wait for, the result arrives
// as a 'compacted' / 'compact-failed' agent event. The API key is added by main.cjs, not by the page.
export function compactConversation(folder: string, branchId: string): Promise<{ compactionId: string }> {
  return request('compact', { folder, branchId });
}

// The connection vault lives in main.cjs (safeStorage) — these ops are answered there,
// never by the worker. The snapshot carries no secret; api_key only ever flows inward.
export function getConnection(folder: string | null): Promise<ConnectionSnapshot> {
  return request('connection-snapshot', { folder });
}

// confirmEndpoint must only be true after the user explicitly agreed to re-bind an
// existing key to a different URL (Connections.save refuses otherwise).
export function saveConnection(
  folder: string | null,
  patch: ConnectionPatch,
  confirmEndpoint = false,
): Promise<ConnectionSnapshot> {
  return announcing(request<ConnectionSnapshot>('save-connection', { folder, patch, authorization: { confirmEndpoint } }));
}

// Zone Danger: none of these delete project files, only history / sidebar entries / settings.
export function clearHistory(folder: string): Promise<{ removed_messages: number }> {
  return request('clear-history', { folder });
}

export function removeFolder(folder: string): Promise<FolderListItem[]> {
  return request('remove-folder', { folder });
}

export function resetGlobalSettings(): Promise<GlobalSettings> {
  return announcing(request<GlobalSettings>('reset-global-settings'));
}

export function getProjectSettings(folder: string): Promise<ProjectSettings> {
  return request('project-settings', { folder });
}

export function saveProjectSettings(folder: string, patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
  return announcing(request<ProjectSettings>('save-project-settings', { folder, patch }));
}

export type {
  AgentEvent,
  Attachment,
  BranchInfo,
  ChatMessage,
  ConnectionPatch,
  ConnectionSnapshot,
  FolderListItem,
  ProjectSettings,
  PromptEntry,
  ProviderName,
} from './types';
