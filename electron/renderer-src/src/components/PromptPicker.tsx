import { useEffect, useRef, useState } from 'react';
import { listPrompts, type PromptEntry } from '../ipc/bridge';
import { applyTemplate, filterPrompts } from '../state/prompts';
import { Modal } from './settings/Modal';

// prompt_library.py: "Bibliothèque de prompts" — a 384 px card with a ✕, a "Filtrer…" field and a list of at
// most 320 px, one row per prompt (icon, name, description). Clicking a row hands the filled-in template to
// the input bar. Escape, ✕ and a click on the backdrop close it. The library is read each time it opens,
// so an edit of prompts.json made by hand is seen without restarting.
export function PromptPicker({
  activeFolder,
  onApply,
  onClose,
}: {
  activeFolder: string | null;
  onApply(text: string): void;
  onClose(): void;
}) {
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listPrompts()
      .then(list => { if (!cancelled) setPrompts(list); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Bibliothèque illisible'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const shown = prompts ? filterPrompts(prompts, query) : [];

  return (
    <Modal width={384} onClose={onClose} dismissOnBackdrop>
      <div data-testid="oa-prompt-picker">
        <div className="mb-1 flex w-full items-center">
          <span className="flex-1 text-xs text-gray-400">Bibliothèque de prompts</span>
          <button
            id="oa-prompt-close-btn"
            type="button"
            aria-label="Fermer"
            onClick={onClose}
            className="h-6 w-6 bg-transparent text-xs text-gray-500 hover:text-white"
          >
            ✕
          </button>
        </div>
        <input
          ref={searchRef}
          id="oa-prompt-filter"
          type="text"
          value={query}
          placeholder="Filtrer…"
          onChange={event => setQuery(event.target.value)}
          className="mb-2 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200 outline-none"
        />
        <div data-testid="oa-prompt-list" className="flex max-h-80 w-full flex-col gap-1 overflow-y-auto">
          {shown.map(prompt => (
            <button
              key={prompt.id}
              type="button"
              data-testid="oa-prompt-item"
              data-prompt-id={prompt.id}
              onClick={() => onApply(applyTemplate(prompt.template, activeFolder))}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800"
            >
              <span className="text-base">{prompt.icon}</span>
              <span className="flex flex-1 flex-col">
                <span className="text-xs font-medium text-gray-200">{prompt.name}</span>
                <span className="text-xs text-gray-500">{prompt.description}</span>
              </span>
            </button>
          ))}
          {error && <span data-testid="oa-prompt-error" className="px-2 py-1 text-xs text-red-400">{error}</span>}
          {prompts && shown.length === 0 && (
            <span data-testid="oa-prompt-empty" className="px-2 py-1 text-xs text-gray-600">
              {prompts.length === 0 ? 'Aucun prompt disponible.' : 'Aucun prompt ne correspond.'}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}
