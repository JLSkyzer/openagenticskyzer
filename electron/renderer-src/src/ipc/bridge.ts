import type { AgentEvent, ChatMessage, FolderListItem } from './types';

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

export type { AgentEvent, ChatMessage, FolderListItem } from './types';
