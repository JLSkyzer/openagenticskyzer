import type { AgentEvent, ChatMessage } from '../ipc/bridge';

export interface ToolMeta {
  tool: string;
  category?: string;
}

// A tool-role message enriched with the tool name/category correlated from the
// tool-start event that preceded it (by tool_call_id) — the raw message alone only
// carries tool_call_id + content, not which tool produced it.
export type RenderedMessage = ChatMessage & { _tool?: string; _category?: string };

export interface ChatState {
  messages: RenderedMessage[];
  liveToolStarts: Record<string, ToolMeta>;
  streamingText: string;
  agentRunning: boolean;
  runId: string | null;
  error: string | null;
}

export const initialChatState: ChatState = {
  messages: [],
  liveToolStarts: {},
  streamingText: '',
  agentRunning: false,
  runId: null,
  error: null,
};

export type ChatAction =
  | { type: 'folder-loaded'; messages: ChatMessage[] }
  | { type: 'send-started'; runId: string; text: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'clear-error' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'folder-loaded':
      return { ...initialChatState, messages: action.messages };

    case 'send-started':
      return {
        ...state,
        messages: [...state.messages, { role: 'user', content: action.text }],
        agentRunning: true,
        runId: action.runId,
        streamingText: '',
        liveToolStarts: {},
        error: null,
      };

    case 'clear-error':
      return { ...state, error: null };

    case 'agent-event': {
      const event = action.event;
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
        case 'done':
        case 'stopped':
          return { ...state, agentRunning: false, runId: null, streamingText: '' };
        case 'error':
          return { ...state, agentRunning: false, runId: null, streamingText: '', error: event.message };
        default:
          // permission-request (Tâche 9) and any future kind fall through untouched.
          return state;
      }
    }
    default:
      return state;
  }
}
