import { useEffect, useRef } from 'react';
import { useChat } from '../state/ChatProvider';
import { lastAssistantIndex } from '../state/editing';
import { assistantDisplay } from '../state/turn-status';
import { AssistantBubble, ReplyTiming, UserBubble } from './MessageBubble';
import { ToolMessage } from './ToolMessage';
import { EmptyState } from './EmptyState';
import { PermissionBanner } from './PermissionBanner';
import { BranchSelector } from './BranchSelector';
import { ProjectTrustBanner } from './ProjectTrustBanner';
import { UpdateBanner } from './UpdateBanner';
import { TurnStatus } from './TurnStatus';

const NOTICE_MS = 3500;

export function ChatView() {
  const { state, activeFolder, forkFrom, editMessage, regenerate, dismissNotice, chooseReasoning } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // The error banner is the last thing in the list: without it here, an error raised while the view
    // is already full (a failed compaction, a refused send) appeared below the fold, out of sight. The status line
    // too: a phase that shows it again (Stop during a permission prompt) must not land below the fold.
  }, [state.messages, state.streamingText, state.streamingReasoning, state.liveToolStarts, state.pendingPermission, state.error, state.phase]);

  // Like ui.notify(): shown briefly, then gone on its own.
  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.notice, dismissNotice]);

  const lastAssistant = lastAssistantIndex(state.messages);
  const pendingTools = Object.entries(state.liveToolStarts);
  // The status line replaces the typing dots for the whole turn. During a permission prompt the banner speaks, as the
  // dots let it, except once Stop is clicked: « Arrêt en cours… » shows at once whatever is pending (ruling S9).
  const showTurnStatus = state.agentRunning && (!state.pendingPermission || state.stopping);
  // An error on an otherwise empty view must still be shown, not hidden behind the welcome screen.
  const hasContent = state.messages.length > 0 || state.agentRunning || state.error !== null;

  return (
    <div style={{ position: 'relative', display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      <BranchSelector />
      <ProjectTrustBanner />
      <UpdateBanner />
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
          <EmptyState activeFolder={activeFolder} />
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden py-3" data-testid="oa-chat-scroll">
          {state.messages.map((message, index) => {
            // The action row is absent (not greyed) while a run is in flight: forking then would cut
            // a transcript that is not saved yet.
            if (message.role === 'user') {
              return (
                <UserBubble
                  key={index}
                  content={message.content}
                  attachments={message.attachments}
                  onFork={state.agentRunning || state.compacting ? undefined : () => void forkFrom(index)}
                  onEdit={state.agentRunning || state.compacting ? undefined : () => void editMessage(index)}
                />
              );
            }
            // A tool-only turn (the model called a tool without any commentary) has empty
            // content — an empty bubble would just be visual noise before the tool card. A reply stopped (or failed)
            // while the model was still reasoning has no answer but its reasoning: that one shows, as its block. An empty
            // tool-call reply that carries the turn's timing (a stop during a tool or a prompt) shows that line alone.
            if (message.role === 'assistant') {
              const display = assistantDisplay(message);
              if (display === 'none') return null;
              if (display === 'timing') return message.timing ? <ReplyTiming key={index} timing={message.timing} alone /> : null;
              return (
                <AssistantBubble
                  key={index}
                  content={message.content}
                  reasoning={typeof message.reasoning === 'string' ? message.reasoning : ''}
                  reasoningMs={message.reasoningMs}
                  reasoningChosen={state.reasoningChoices[index]}
                  onReasoningChoose={open => chooseReasoning(index, open)}
                  timing={message.timing}
                  onRegenerate={index === lastAssistant && !state.agentRunning && !state.compacting ? () => void regenerate() : undefined}
                />
              );
            }
            if (message.role === 'tool') {
              return <ToolMessage key={index} tool={message._tool} category={message._category} detail={message._detail} content={message.content} />;
            }
            return null;
          })}
          {pendingTools.map(([id, meta]) => (
            <ToolMessage key={id} tool={meta.tool} category={meta.category} detail={meta.detail} content="" pending />
          ))}
          {/* The block is open while the model reasons (through a Stop clicked meanwhile), then the user's (ruling M4). */}
          {state.agentRunning && (state.streamingText || state.streamingReasoning.trim()) && (
            <AssistantBubble
              content={state.streamingText}
              reasoning={state.streamingReasoning}
              reasoningOpen={(state.stopping ? state.phaseBeforeStop : state.phase)?.phase === 'thinking'}
              // The index the reply will take once saved: the user's choice made now stays with it.
              reasoningChosen={state.reasoningChoices[state.messages.length]}
              onReasoningChoose={open => chooseReasoning(state.messages.length, open)}
              streaming
            />
          )}
          {showTurnStatus && <TurnStatus />}
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
