export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

// Mirrors core/conversations.mts::Conversations.list() — 'main' is always the first entry.
export interface BranchInfo {
  id: string;
  label: string;
  created_at: string;
  message_count: number;
}

// Mirrors core/folders.mts::FolderListItem exactly.
export interface FolderListItem {
  path: string;
  name: string;
  last_used: string;
}

export type ProviderName =
  | 'openrouter' | 'together' | 'groq' | 'mistral' | 'gemini' | 'ollama' | 'lmstudio' | 'llamacpp';

// Mirrors core/connections.mts::Connections.snapshot() — deliberately has no api_key and
// no key_endpoint: the secret never reaches the renderer, only whether one is configured.
export interface ConnectionSnapshot {
  provider: ProviderName;
  model: string;
  base_url: string;
  key_source: string;
  legacy_plaintext: boolean;
  model_source: string;
  key_configured: boolean;
}

// Mirrors core/connections.mts::ConnectionPatch. api_key is write-only: a string sets it,
// null clears it, undefined leaves it untouched.
export interface ConnectionPatch {
  provider: ProviderName;
  model?: string;
  base_url?: string;
  api_key?: string | null;
}

// Mirrors core/settings.mts::projectDefaults plus the optional per-project permission
// overrides that projectRules also accepts.
export interface ProjectSettings {
  agent_mode: 'inherit' | 'ask' | 'auto' | 'plan';
  ignored_patterns: string;
  custom_prompt: string;
  override_permissions: boolean;
  permission_mode?: 'demander' | 'auto' | 'strict';
  shell_ask?: boolean;
  files_ask?: boolean;
  search_ask?: boolean;
}

// Mirrors the events worker.mjs posts on the existing `backend-message` channel for an
// agent run (agent.mts::runAgent's `emit` option, enriched with runId/category) — see
// the "Canal IPC streaming" section of the socle plan.
export type AgentEvent =
  | { type: 'event'; event: 'agent'; runId: string; kind: 'turn'; step: number }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'delta'; text: string }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'message'; message: ChatMessage }
  | {
      // worker.mjs only enriches agent.mts's own emit({type:'tool-start', id, tool})
      // with `category` — no `arguments` here (unlike permission-request, which the
      // worker constructs itself and does include them).
      type: 'event';
      event: 'agent';
      runId: string;
      kind: 'tool-start';
      id: string;
      tool: string;
      category?: string;
    }
  | {
      type: 'event';
      event: 'agent';
      runId: string;
      kind: 'permission-request';
      requestId: string;
      tool: string;
      category?: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'done' }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'stopped' }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'error'; message: string }
  // A compaction reuses the agent event channel with its own id in `runId`: `messages` is the whole
  // conversation as saved, summary first.
  | { type: 'event'; event: 'agent'; runId: string; kind: 'compacted'; messages: ChatMessage[] }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'compact-failed'; message: string };

export interface OpenAgentBridge {
  request(request: { op: string; payload?: Record<string, unknown> }): Promise<unknown>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    openagent: OpenAgentBridge;
  }
}
