import { useCallback, useRef, type KeyboardEvent } from 'react';
import { useChat } from '../state/ChatProvider';
import { ModelButton } from './model/ModelButton';

// Uncontrolled textarea (ref, not useState) — matches input_bar.py's intent (plain text
// box, no per-keystroke React state) and avoids re-rendering the whole bar on every key.
export function InputBar() {
  const { state, activeFolder, send, stopRun } = useChat();
  const textRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const el = textRef.current;
    if (!el || !el.value.trim() || state.agentRunning) return;
    const text = el.value;
    el.value = '';
    await send(text);
  }, [send, state.agentRunning]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter alone sends; Shift/Ctrl/Alt+Enter inserts a newline (native textarea
      // behavior, untouched).
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className="oa-input-col flex flex-col gap-1 px-3 pb-3 pt-2"
      style={{ background: 'var(--surface, #111)', borderTop: '1px solid var(--border, #1e1e1e)' }}
    >
      <div className="flex items-end gap-2">
        <textarea
          id="oa-input-ta"
          ref={textRef}
          rows={2}
          placeholder="Un message…"
          onKeyDown={handleKeyDown}
          className="oa-input-ta min-h-[40px] flex-1 resize-y rounded-lg px-3 py-2 text-xs outline-none"
          style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#e0e0e0' }}
        />
        <ModelButton activeFolder={activeFolder} />
        <button
          id="oa-send-btn"
          onClick={() => (state.agentRunning ? stopRun() : handleSend())}
          className="oa-send-btn flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ background: state.agentRunning ? '#b91c1c' : '#9333ea', border: 'none', cursor: 'pointer' }}
        >
          {state.agentRunning ? '■' : '➤'}
        </button>
      </div>
      <span className="text-[11px]" style={{ color: 'var(--text-muted, #6b7280)' }}>
        Entrée → envoyer · Shift+Entrée → nouvelle ligne
      </span>
    </div>
  );
}
