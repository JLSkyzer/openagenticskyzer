export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

// Mirrors core/folders.mts::FolderListItem exactly.
export interface FolderListItem {
  path: string;
  name: string;
  last_used: string;
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
  | { type: 'event'; event: 'agent'; runId: string; kind: 'error'; message: string };

export interface OpenAgentBridge {
  request(request: { op: string; payload?: Record<string, unknown> }): Promise<unknown>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    openagent: OpenAgentBridge;
  }
}
