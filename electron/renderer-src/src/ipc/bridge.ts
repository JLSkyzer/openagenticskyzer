import type {
  AgentEvent,
  BranchInfo,
  ChatMessage,
  ConnectionPatch,
  ConnectionSnapshot,
  FolderListItem,
  ProjectSettings,
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
): Promise<{ runId: string }> {
  return request('send', { folder, branchId, text });
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

export function saveGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  return request('save-global-settings', { patch });
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
  return request('save-connection', { folder, patch, authorization: { confirmEndpoint } });
}

// Zone Danger: none of these delete project files, only history / sidebar entries / settings.
export function clearHistory(folder: string): Promise<{ removed_messages: number }> {
  return request('clear-history', { folder });
}

export function removeFolder(folder: string): Promise<FolderListItem[]> {
  return request('remove-folder', { folder });
}

export function resetGlobalSettings(): Promise<GlobalSettings> {
  return request('reset-global-settings');
}

export function getProjectSettings(folder: string): Promise<ProjectSettings> {
  return request('project-settings', { folder });
}

export function saveProjectSettings(folder: string, patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
  return request('save-project-settings', { folder, patch });
}

export type {
  AgentEvent,
  BranchInfo,
  ChatMessage,
  ConnectionPatch,
  ConnectionSnapshot,
  FolderListItem,
  ProjectSettings,
  ProviderName,
} from './types';
