import { useEffect, useRef } from 'react';
import { useChat } from '../state/ChatProvider';
import { AssistantBubble, UserBubble } from './MessageBubble';
import { ToolMessage } from './ToolMessage';
import { EmptyState } from './EmptyState';
import { PermissionBanner } from './PermissionBanner';
import { BranchSelector } from './BranchSelector';

const NOTICE_MS = 3500;

export function ChatView() {
  const { state, forkFrom, dismissNotice } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // The error banner is the last thing in the list: without it here, an error raised while the view
    // is already full (a failed compaction, a refused send) appeared below the fold, out of sight.
  }, [state.messages, state.streamingText, state.liveToolStarts, state.pendingPermission, state.error]);

  // Like ui.notify(): shown briefly, then gone on its own.
  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.notice, dismissNotice]);

  const pendingTools = Object.entries(state.liveToolStarts);
  const waitingForFirstToken =
    state.agentRunning && !state.streamingText && pendingTools.length === 0 && !state.pendingPermission;
  // An error on an otherwise empty view must still be shown, not hidden behind the welcome screen.
  const hasContent = state.messages.length > 0 || state.agentRunning || state.error !== null;

  return (
    <div style={{ position: 'relative', display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      <BranchSelector />
      {state.notice && (
        <div
          role="status"
          data-testid="oa-notice"
          className="absolute right-4 top-3 z-10 rounded bg-green-700 px-3 py-2 text-xs text-white shadow-lg"
        >
          {state.notice}
        </div>
      )}
      {!hasContent ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <EmptyState />
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-3" data-testid="oa-chat-scroll">
          {state.messages.map((message, index) => {
            // The action row is absent (not greyed) while a run is in flight: forking then would cut
            // a transcript that is not saved yet.
            if (message.role === 'user') {
              return (
                <UserBubble
                  key={index}
                  content={message.content}
                  onFork={state.agentRunning || state.compacting ? undefined : () => void forkFrom(index)}
                />
              );
            }
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
          <PermissionBanner />
          {state.error && (
            <div data-testid="oa-chat-error" className="mx-4 my-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {state.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
