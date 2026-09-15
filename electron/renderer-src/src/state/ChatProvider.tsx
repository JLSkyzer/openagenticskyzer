import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';
import { getMessages, onAgentEvent, sendMessage, stop } from '../ipc/bridge';
import { chatReducer, initialChatState, type ChatState } from './reducer';

interface ChatContextValue {
  state: ChatState;
  send(text: string): Promise<void>;
  stopRun(): Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ activeFolder, children }: { activeFolder: string | null; children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    getMessages(activeFolder)
      .then(messages => {
        if (!cancelled) dispatch({ type: 'folder-loaded', messages });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
