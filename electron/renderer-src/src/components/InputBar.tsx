import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useChat } from '../state/ChatProvider';
import { ModelButton } from './model/ModelButton';
import { PromptPicker } from './PromptPicker';
import { AttachmentChips } from './AttachmentChips';
import { useRegisterAction } from '../state/ActionRegistry';
import { useToast } from '../state/ToastProvider';
import { ACCEPT_ATTRIBUTE, processUpload } from '../state/upload';
import type { Attachment } from '../ipc/bridge';

// Uncontrolled textarea (ref, not useState) — matches input_bar.py's intent (plain text
// box, no per-keystroke React state) and avoids re-rendering the whole bar on every key.
export function InputBar() {
  const { state, activeFolder, send, stopRun, draft } = useChat();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const { notify } = useToast();

  // ✏️ hands a message back: like a prompt from the library it REPLACES what was typed, takes the focus and
  // puts the caret at the end. Keyed on the nonce, so editing the same message twice refills the box again. Its
  // files come back with it (cutting the message cut them too), so nothing has to be attached again.
  useEffect(() => {
    const el = textRef.current;
    if (!draft || !el) return;
    el.value = draft.text;
    setAttachments(draft.attachments);
    el.focus();
    el.setSelectionRange(draft.text.length, draft.text.length);
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // input_bar.py::_handle_upload, for a chosen, pasted or dropped file: processed here, added to what will be
  // sent, and reported the same three ways (added / unsupported / error).
  const addFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const attachment = await processUpload(file.name, new Uint8Array(await file.arrayBuffer()));
        if (attachment) {
          setAttachments(current => [...current, attachment]);
          notify(`📎 ${file.name} ajouté`, 'positive');
        } else {
          notify(`Format non supporté : ${file.name}`, 'warning');
        }
      } catch (error) {
        notify(`Erreur upload : ${error instanceof Error ? error.message : String(error)}`, 'negative');
      }
    }
  }, [notify]);

  // A file dropped anywhere else in the window would make Electron navigate to it and unload the whole app.
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => { window.removeEventListener('dragover', swallow); window.removeEventListener('drop', swallow); };
  }, []);

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return; // plain text: the box pastes it as usual
    event.preventDefault();
    void addFiles(files);
  };
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const handleDragOver = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } };
  const handleDragLeave = (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); };
  const handleDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const handleSend = useCallback(async () => {
    const el = textRef.current;
    // While a summary is being made the transcript is rewritten: a message sent now would be lost in it.
    // Checked BEFORE the box is emptied, so the typed text stays for when the compaction is over.
    if (!el || !el.value.trim() || state.agentRunning || state.compacting) return;
    const text = el.value;
    const files = attachments;
    el.value = '';
    setAttachments([]); // the files leave with the message (state.attached_files.clear())
    await send(text, files);
  }, [send, state.agentRunning, state.compacting, attachments]);

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
      data-testid="oa-input-col"
      data-dragging={dragging ? 'true' : undefined}
      className="oa-input-col flex flex-col gap-1 px-3 pb-3 pt-2"
      style={{ background: 'var(--surface, #111)', borderTop: '1px solid var(--border, #1e1e1e)', outline: dragging ? '2px dashed #9333ea' : 'none', outlineOffset: -4 }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-end gap-2">
        <textarea
          id="oa-input-ta"
          ref={textRef}
          rows={2}
          placeholder="Un message…"
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
        {/* input_bar.py: a hidden multi-file picker behind the 📎 button; the file types are the ones processUpload knows. */}
        <input
          ref={fileRef}
          id="oa-file-input"
          data-testid="oa-file-input"
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={event => {
            const files = [...(event.target.files ?? [])];
            event.target.value = ''; // the same file can be chosen again
            void addFiles(files);
          }}
        />
        <button
          id="oa-attach-btn"
          type="button"
          title="Joindre des fichiers"
          aria-label="Joindre des fichiers"
          onClick={() => fileRef.current?.click()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm text-gray-300"
          style={{ background: '#111827', border: '1px solid #374151' }}
        >
          📎
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
      <AttachmentChips attachments={attachments} onRemove={index => setAttachments(current => current.filter((_, i) => i !== index))} />
      <span className="text-[11px]" style={{ color: 'var(--text-muted, #6b7280)' }}>
        Entrée → envoyer · Shift+Entrée → nouvelle ligne · Ctrl+K → commandes
      </span>
      {pickerOpen && <PromptPicker activeFolder={activeFolder} onApply={applyPrompt} onClose={closePicker} />}
    </div>
  );
}
