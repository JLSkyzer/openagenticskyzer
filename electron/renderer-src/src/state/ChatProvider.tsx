import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import { onAgentEvent, sendMessage, stop, type ChatMessage } from '../ipc/bridge';
import { chatReducer, initialChatState, type ChatState } from './reducer';

interface ChatContextValue {
  state: ChatState;
  send(text: string): Promise<void>;
  stopRun(): Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

interface ChatProviderProps {
  activeFolder: string | null;
  // The Sidebar's own activate_folder call already returns this history — re-fetching
  // it here via a second async round trip is not just redundant, it is a real race: if
  // that fetch resolves after a send() has already started for the new folder, its
  // 'folder-loaded' dispatch resets the whole reducer state and silently discards the
  // in-flight run. Taking it as a prop keeps the dispatch synchronous with the folder
  // change instead.
  initialMessages: ChatMessage[];
  children: ReactNode;
}

export function ChatProvider({ activeFolder, initialMessages, children }: ChatProviderProps) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const initialMessagesRef = useRef(initialMessages);
  initialMessagesRef.current = initialMessages;

  useEffect(() => {
    if (!activeFolder) return;
    dispatch({ type: 'folder-loaded', messages: initialMessagesRef.current });
    // Intentionally keyed on activeFolder alone: this must fire exactly once per folder
    // switch, reading whichever initialMessages the Sidebar handed over for that same
    // switch — not on every initialMessages identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder]);

  useEffect(() => onAgentEvent(event => dispatch({ type: 'agent-event', event })), []);

  const send = useCallback(
    async (text: string) => {
      if (!activeFolder || !text.trim()) return;
      const { runId } = await sendMessage(activeFolder, 'main', text);
      dispatch({ type: 'send-started', runId, text });
    },
    [activeFolder],
  );

  const stopRun = useCallback(async () => {
    if (state.runId) await stop(state.runId);
  }, [state.runId]);

  return <ChatContext.Provider value={{ state, send, stopRun }}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat doit être utilisé à l’intérieur de ChatProvider');
  return ctx;
}
