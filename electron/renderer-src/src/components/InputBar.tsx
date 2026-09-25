import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useChat } from '../state/ChatProvider';
import { ModelButton } from './model/ModelButton';
import { PromptPicker } from './PromptPicker';
import { useRegisterAction } from '../state/ActionRegistry';

// Uncontrolled textarea (ref, not useState) — matches input_bar.py's intent (plain text
// box, no per-keystroke React state) and avoids re-rendering the whole bar on every key.
export function InputBar() {
  const { state, activeFolder, send, stopRun, draft } = useChat();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ✏️ hands a message back: like a prompt from the library it REPLACES what was typed, takes the focus and
  // puts the caret at the end. Keyed on the nonce, so editing the same message twice refills the box again.
  useEffect(() => {
    const el = textRef.current;
    if (!draft || !el) return;
    el.value = draft.text;
    el.focus();
    el.setSelectionRange(draft.text.length, draft.text.length);
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(async () => {
    const el = textRef.current;
    // While a summary is being made the transcript is rewritten: a message sent now would be lost in it.
    // Checked BEFORE the box is emptied, so the typed text stays for when the compaction is over.
    if (!el || !el.value.trim() || state.agentRunning || state.compacting) return;
    const text = el.value;
    el.value = '';
    await send(text);
  }, [send, state.agentRunning, state.compacting]);

  // The picker hands the filled-in template over. As in prompt_library.py it REPLACES what was typed (the
  // user chose it on purpose), gives the box the focus back and, here, puts the caret at the end so a
  // template that ends open ("Analyse cette erreur :") can be continued right away.
  const applyPrompt = useCallback((text: string) => {
    const el = textRef.current;
    setPickerOpen(false);
    if (!el) return;
    el.value = text;
    el.focus();
    el.setSelectionRange(text.length, text.length);
  }, []);

  // "📋 Bibliothèque de prompts" of the command palette opens the same window as the ✦ button.
  useRegisterAction('open-prompts', () => setPickerOpen(true));

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    textRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // "/" as the very first character of an empty box opens the prompt library. Unlike the NiceGUI
      // version the slash is NOT typed into the box (a stray "/" stayed behind when the picker was
      // closed). Shift is allowed: on an AZERTY keyboard "/" is Shift+":".
      if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey && event.currentTarget.value === '') {
        event.preventDefault();
        setPickerOpen(true);
        return;
      }
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
          id="oa-prompt-btn"
          type="button"
          title="Bibliothèque de prompts"
          aria-label="Bibliothèque de prompts"
          onClick={() => setPickerOpen(true)}
          className="flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-sm text-purple-400 hover:text-purple-300"
          style={{ background: '#111827', border: '1px solid #1f2937' }}
        >
          ✦
        </button>
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
        Entrée → envoyer · Shift+Entrée → nouvelle ligne · Ctrl+K → commandes
      </span>
      {pickerOpen && <PromptPicker activeFolder={activeFolder} onApply={applyPrompt} onClose={closePicker} />}
    </div>
  );
}
