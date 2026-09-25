import type { AgentEvent, Attachment, BranchInfo, ChatMessage } from '../ipc/bridge';
// Explicit `.ts`: the unit tests load this file with Node itself (type stripping), which does not resolve
// extension-less imports the way Vite does.
import { extractArtifact, type Artifact } from './artifacts.ts';
import { lastAssistantIndex } from './editing.ts';

export interface ToolMeta {
  tool: string;
  category?: string;
}

// A tool-role message enriched with the tool name/category correlated from the
// tool-start event that preceded it (by tool_call_id) — the raw message alone only
// carries tool_call_id + content, not which tool produced it.
export type RenderedMessage = ChatMessage & { _tool?: string; _category?: string };

export interface PendingPermission {
  requestId: string;
  tool: string;
  category?: string;
  arguments: Record<string, unknown>;
}

export interface ChatState {
  messages: RenderedMessage[];
  liveToolStarts: Record<string, ToolMeta>;
  streamingText: string;
  agentRunning: boolean;
  runId: string | null;
  error: string | null;
  pendingPermission: PendingPermission | null;
  // The folder's saved branches (main first) and the one whose messages are on screen. Empty /
  // 'main' until a folder is opened; the selector only shows once a fork exists.
  branches: BranchInfo[];
  currentBranchId: string;
  // A short positive message ("Branche 'X' créée.") shown once, like ui.notify(type="positive").
  notice: string | null;
  // A summary of the conversation is being made in the background: `compactionId` is the id its
  // closing event will carry. It rewrites the branch on screen, so branch operations wait for it.
  compacting: boolean;
  compactionId: string | null;
  // Turns that ended normally since the folder was opened (not Stop, not error): what the automatic
  // compaction reacts to, as input_bar.py only checks the gauge after a successful turn.
  completedTurns: number;
  // ✏️: the view was cut to this many messages but the saved history was NOT (abandoning the edit must
  // destroy nothing, as in the NiceGUI app). The next send hands it to the worker as `keep`, which cuts
  // the saved history at the same place. null = the view matches what is saved.
  truncatedTo: number | null;
  // The side preview (artifact_panel.py): the first html/svg/mermaid/markdown block of the last reply that
  // ended normally. null = panel closed.
  artifact: Artifact | null;
}

export const initialChatState: ChatState = {
  messages: [],
  liveToolStarts: {},
  streamingText: '',
  agentRunning: false,
  runId: null,
  error: null,
  pendingPermission: null,
  branches: [],
  currentBranchId: 'main',
  notice: null,
  compacting: false,
  compactionId: null,
  completedTurns: 0,
  truncatedTo: null,
  artifact: null,
};

export type ChatAction =
  | { type: 'folder-loaded'; messages: ChatMessage[] }
  | { type: 'branches-loaded'; branches: BranchInfo[] }
  | { type: 'branch-created'; id: string; label: string; branches: BranchInfo[]; messages: ChatMessage[] }
  | { type: 'branch-switched'; id: string; messages: ChatMessage[] }
  | { type: 'branch-failed'; error: string }
  | { type: 'compaction-started'; id: string }
  | { type: 'show-error'; error: string }
  | { type: 'clear-notice' }
  | { type: 'send-started'; runId: string; text: string; keep?: number; attachments?: Attachment[] }
  | { type: 'messages-truncated'; keep: number }
  | { type: 'artifact-closed' }
  | { type: 'send-failed'; error: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'permission-decided' }
  | { type: 'clear-error' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'folder-loaded':
      // A new folder always opens on main: its fork list arrives separately ('branches-loaded').
      return { ...initialChatState, messages: action.messages };

    case 'branches-loaded':
      return { ...state, branches: action.branches };

    // Fork and switch replace the messages on screen, so they are ignored while a run is in
    // flight: a late answer must never swap the view out from under the agent that is writing to it.
    case 'branch-created':
      if (state.agentRunning || state.compacting) return state;
      return {
        ...state,
        branches: action.branches,
        currentBranchId: action.id,
        messages: action.messages,
        truncatedTo: null,
        error: null,
        notice: `Branche '${action.label}' créée.`,
      };

    case 'branch-switched':
      if (state.agentRunning || state.compacting) return state;
      return {
        ...state,
        currentBranchId: action.id,
        messages: action.messages,
        truncatedTo: null,
        streamingText: '',
        liveToolStarts: {},
        pendingPermission: null,
        error: null,
        notice: null,
      };

    case 'branch-failed':
      return { ...state, error: action.error };

    case 'clear-notice':
      return { ...state, notice: null };

    case 'compaction-started':
      return { ...state, compacting: true, compactionId: action.id, truncatedTo: null, error: null };

    case 'show-error':
      return { ...state, error: action.error };

    // Like fork and switch, a cut replaces what is on screen: ignored while a run or a summary owns it.
    case 'messages-truncated':
      if (state.agentRunning || state.compacting) return state;
      return { ...state, messages: state.messages.slice(0, action.keep), truncatedTo: action.keep, error: null, notice: null };

    case 'send-started':
      return {
        ...state,
        // `keep` (🔄 regenerate) cuts the view before the message is added — in the same step, so a send
        // that the worker refuses never leaves a half-cut view behind.
        messages: [
          ...(action.keep === undefined ? state.messages : state.messages.slice(0, action.keep)),
          { role: 'user', content: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}) },
        ],
        truncatedTo: null,
        agentRunning: true,
        runId: action.runId,
        streamingText: '',
        liveToolStarts: {},
        error: null,
      };

    case 'send-failed':
      // The IPC round trip itself failed (e.g. a rejected connection resolution) before
      // any runId ever existed — nothing to mark as running, just surface the failure.
      return { ...state, error: action.error };

    case 'clear-error':
      return { ...state, error: null };

    case 'artifact-closed':
      return { ...state, artifact: null };

    case 'permission-decided':
      return { ...state, pendingPermission: null };

    case 'agent-event': {
      const event = action.event;
      // The end of a compaction carries the compaction's id, not the run's: a stale one (another
      // folder, an older request) matches nothing we wait for and changes nothing.
      if (event.kind === 'compacted' || event.kind === 'compact-failed') {
        if (!state.compacting || event.runId !== state.compactionId) return state;
        if (event.kind === 'compact-failed') return { ...state, compacting: false, compactionId: null, error: event.message };
        return { ...state, compacting: false, compactionId: null, messages: event.messages, error: null, notice: 'Contexte compressé avec résumé IA.' };
      }
      // A stale event from a run that Stop already superseded — ignore it rather than
      // corrupting the view of the (now different) active run.
      if (event.runId !== state.runId) return state;
      switch (event.kind) {
        case 'turn':
          return state;
        case 'delta':
          return { ...state, streamingText: state.streamingText + event.text };
        case 'tool-start':
          return {
            ...state,
            liveToolStarts: { ...state.liveToolStarts, [event.id]: { tool: event.tool, category: event.category } },
          };
        case 'message': {
          const message = event.message;
          if (message.role === 'tool' && message.tool_call_id) {
            const meta = state.liveToolStarts[message.tool_call_id];
            const { [message.tool_call_id]: _removed, ...remaining } = state.liveToolStarts;
            return {
              ...state,
              messages: [...state.messages, { ...message, _tool: meta?.tool, _category: meta?.category }],
              liveToolStarts: remaining,
            };
          }
          return {
            ...state,
            messages: [...state.messages, message],
            streamingText: message.role === 'assistant' ? '' : state.streamingText,
          };
        }
        case 'permission-request':
          return {
            ...state,
            pendingPermission: {
              requestId: event.requestId,
              tool: event.tool,
              category: event.category,
              arguments: event.arguments,
            },
          };
        case 'done': {
          // input_bar.py: only a turn that ENDED looks for an artifact; one found replaces the open one, none
          // found leaves it alone.
          const reply = lastAssistantIndex(state.messages);
          const found = reply < 0 ? null : extractArtifact(state.messages[reply].content);
          return {
            ...state, agentRunning: false, runId: null, streamingText: '', liveToolStarts: {}, pendingPermission: null,
            completedTurns: state.completedTurns + 1,
            artifact: found ?? state.artifact,
          };
        }
        case 'stopped':
          // Also clear liveToolStarts and any pendingPermission: a Stop while waiting
          // on a decision (or mid tool-execute) leaves no further event for that call
          // (agent.mts re-throws the abort before building one), so without this a
          // "pending" tool card or a stale permission banner would stay stuck forever.
          return { ...state, agentRunning: false, runId: null, streamingText: '', liveToolStarts: {}, pendingPermission: null };
        case 'error':
          return {
            ...state,
            agentRunning: false,
            runId: null,
            streamingText: '',
            liveToolStarts: {},
            pendingPermission: null,
            error: event.message,
          };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}
