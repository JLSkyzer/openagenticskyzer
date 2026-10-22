import type { Attachment } from '../../../core/attachments.mts';
export type { Attachment };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  // A user message's files (📎 / paste / drop), kept beside what was typed.
  attachments?: Attachment[];
  tool_call_id?: string;
  [key: string]: unknown;
}

// Mirrors core/prompts.mts::Prompt — the prompt library entries, icon and description always filled in.
export interface PromptEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  template: string;
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

// Mirrors core/active-model.mts::ModelStatus: the active .gguf (name null when none, or when its file is gone —
// missing then says so) and the window its engine runs with (MIN_LOCAL_CONTEXT until it has loaded).
export interface ModelStatus {
  id: string;
  name: string | null;
  missing: boolean;
  contextWindow: number;
  loaded: boolean;
  /** Omitted when unknown: the loaded truth once the model is loaded, else the cached estimate, if any. */
  placement?: Placement;
}

// Mirrors core/placement.mts.
export type Backend = 'cuda' | 'vulkan' | 'metal' | 'cpu';
export type Fit = 'gpu' | 'split' | 'cpu' | 'none';
export interface Placement {
  source: 'estimate' | 'loaded';
  backend: Backend;
  gpuLayers: number;
  totalLayers: number;
  contextSize: number;
  vramBytes: number;
  ramBytes: number;
  /** The byte figures are node-llama-cpp's own estimates, never a measurement. */
  memoryMeasured: false;
  fit: Fit;
}

// Mirrors core/llama-runtime.mts::GpuBackendChoice (the gpu_backend setting).
export type GpuBackendChoice = 'auto' | 'cuda' | 'vulkan' | 'cpu';

// Mirrors core/hardware.mts::HardwareInfo, plus what worker.mjs adds to op hardware-info.
export interface HardwareInfo {
  backend: Backend;
  gpuNames: string[];
  vram: { total: number; free: number } | null;
  ram: { total: number; free: number };
  cpu: { model: string; mathCores: number; logicalCores: number };
  nvidia: boolean;
  /** Why the engine is not on the expected backend (a CUDA pack that failed or is stale), else null. */
  notice: string | null;
  /** The gpu_backend this worker started with (the backend is decided once per app start). */
  backendChoice: GpuBackendChoice;
  /** What is saved now (pack, gpu_backend) needs an app restart to apply. */
  restartRequired: boolean;
}

// Mirrors core/cuda-pack.mts::CudaPackStatus, plus what worker.mjs adds (CudaPackView).
export type CudaPackState = 'unavailable' | 'absent' | 'installing' | 'installed' | 'mismatch';
export interface CudaPackView {
  state: CudaPackState;
  downloadBytes: number | null;
  installedBytes: number | null;
  installedVersion: string | null;
  expectedVersion: string;
  restartRequired: boolean;
  notice: string | null;
  /** The running install (its id and last progress), so a view opened mid-install can follow and cancel it; else null. */
  install: { installId: string; receivedBytes: number; totalBytes: number } | null;
}

// A CUDA pack install's progress and end (worker.mjs, op cuda-pack-install).
export type CudaPackProgress = { installId: string } & (
  | { state: 'progress'; receivedBytes: number; totalBytes: number }
  | { state: 'done' }
  | { state: 'cancelled' }
  | { state: 'error'; message: string }
);
export type CudaPackEvent = { type: 'event'; event: 'cuda-pack' } & CudaPackProgress;

// The end of a background offload estimate (worker.mjs, op estimate-model).
export interface EstimateEvent {
  type: 'event';
  event: 'estimate';
  estimateId: string;
  modelId: string;
  state: 'done' | 'cancelled' | 'error';
  estimate?: Placement;
  message?: string;
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

// A turn's phase as the worker posts it (worker.mjs::runSend's phase()), mirroring core/model-types.mts.
export type TurnPhaseName = 'preparing' | 'loading' | 'reading' | 'thinking' | 'writing' | 'tool' | 'stopping';
// A turn's figures, joined to its done / stopped (mirrors core/model-types.mts::TurnTiming).
export interface TurnTiming { loadMs?: number; readMs?: number; firstTextMs?: number; totalMs: number; outputTokens?: number; tokensPerSecond?: number }

// Mirrors the events worker.mjs posts on the existing `backend-message` channel for an
// agent run (agent.mts::runAgent's `emit` option, enriched with runId/category) — see
// the "Canal IPC streaming" section of the socle plan.
export type AgentEvent =
  | { type: 'event'; event: 'agent'; runId: string; kind: 'turn'; step: number }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'delta'; text: string }
  // The reasoning as it streams (core/model-types.mts::onReasoning): `moved` takes back the text streamed so far as
  // reasoning; `movedBack` is the reverse — the template opened <think>, no </think> came, and `text` (all the
  // reasoning streamed so far) was the answer.
  | { type: 'event'; event: 'agent'; runId: string; kind: 'thinking'; text: string; moved?: true; movedBack?: true }
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
  // `loading` carries its progress in whole percents once the load reports one, `tool` the tool's name.
  | { type: 'event'; event: 'agent'; runId: string; kind: 'phase'; phase: TurnPhaseName; progress?: number; tool?: string }
  // `timing` is optional: older tests post them bare.
  | { type: 'event'; event: 'agent'; runId: string; kind: 'done'; timing?: TurnTiming }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'stopped'; timing?: TurnTiming }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'error'; message: string }
  // A compaction reuses the agent event channel with its own id in `runId`: `messages` is the whole
  // conversation as saved, summary first.
  | { type: 'event'; event: 'agent'; runId: string; kind: 'compacted'; messages: ChatMessage[] }
  | { type: 'event'; event: 'agent'; runId: string; kind: 'compact-failed'; message: string };

// index_status (semantic search): mirrors worker.mjs::postIndexEvent, one per folder. 'error' is a
// real state the original NiceGUI app never had (it silently fell back to an empty string).
export type IndexState = 'idle' | 'indexing' | 'ready' | 'error';
export interface IndexEvent {
  type: 'event';
  event: 'index';
  folder: string;
  state: IndexState;
  current?: number;
  total?: number;
  message?: string;
}

export interface UpdateStatus {
  enabled: boolean;
  /** False only in development: a packaged app can still have updates switched off (OPENAGENT_DISABLE_UPDATES=1). */
  packaged: boolean;
  currentVersion: string;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  at: string | null;
}

export interface OpenAgentBridge {
  request(request: { op: string; payload?: Record<string, unknown> }): Promise<unknown>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onIndexEvent(callback: (event: IndexEvent) => void): () => void;
  onModelEvent(callback: (status: ModelStatus & { type: 'event'; event: 'model' }) => void): () => void;
  onEstimateEvent(callback: (event: EstimateEvent) => void): () => void;
  onCudaPackEvent(callback: (event: CudaPackEvent) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    openagent: OpenAgentBridge;
  }
}
