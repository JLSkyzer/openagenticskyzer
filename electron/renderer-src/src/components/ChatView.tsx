import { useEffect, useRef } from 'react';
import { useChat } from '../state/ChatProvider';
import { AssistantBubble, UserBubble } from './MessageBubble';
import { ToolMessage } from './ToolMessage';
import { EmptyState } from './EmptyState';

export function ChatView() {
  const { state } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streamingText, state.liveToolStarts]);

  const pendingTools = Object.entries(state.liveToolStarts);
  const waitingForFirstToken = state.agentRunning && !state.streamingText && pendingTools.length === 0;
  const hasContent = state.messages.length > 0 || state.agentRunning;

  if (!hasContent) return <EmptyState />;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto py-3"
      style={{ background: 'var(--bg)' }}
      data-testid="oa-chat-scroll"
    >
      {state.messages.map((message, index) => {
        if (message.role === 'user') return <UserBubble key={index} content={message.content} />;
        // A tool-only turn (the model called a tool without any commentary) has empty
        // content — an empty bubble would just be visual noise before the tool card.
        if (message.role === 'assistant') {
          return message.content.trim() ? <AssistantBubble key={index} content={message.content} /> : null;
        }
        if (message.role === 'tool') {
          return <ToolMessage key={index} tool={message._tool} category={message._category} content={message.content} />;
        }
        return null;
      })}
      {pendingTools.map(([id, meta]) => (
        <ToolMessage key={id} tool={meta.tool} category={meta.category} content="" pending />
      ))}
      {state.agentRunning && state.streamingText && <AssistantBubble content={state.streamingText} streaming />}
      {waitingForFirstToken && (
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="oa-typing-dots" aria-label="En cours…" />
        </div>
      )}
      {state.error && (
        <div className="mx-4 my-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">
          {state.error}
        </div>
      )}
    </div>
  );
}
