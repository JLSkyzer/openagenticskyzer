import { useCallback, useEffect, useState } from 'react';
import { addKnowledgeFile, listKnowledge, pickKnowledgeFile, removeKnowledgeSource } from '../ipc/bridge';
import { useToast } from '../state/ToastProvider';

// sidebar.py::_render_knowledge_section, made REAL: reading the whole Python file shows
// "+ Ajouter un document" only ever calls _open_knowledge_import, which shows a ui.notify() hint
// ("Glisse un fichier .txt ou .md sur l'app pour l'ajouter.") — add_to_knowledge is never called
// anywhere in that repo. This is a working native file picker wired to a real, working import.
export function KnowledgeSection() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const { notify } = useToast();

  const refresh = useCallback(() => {
    listKnowledge().then(setSources).catch(() => {});
  }, []);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleAdd = useCallback(async () => {
    setAdding(true);
    try {
      const picked = await pickKnowledgeFile();
      if (!picked) return;
      const result = await addKnowledgeFile(picked);
      notify(`✓ « ${result.source} » ajouté à la base de connaissances (${result.chunks} passage(s)).`, 'positive');
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Impossible d'ajouter ce document.", 'negative');
    } finally {
      setAdding(false);
    }
  }, [notify, refresh]);

  const handleRemove = useCallback(
    async (source: string) => {
      try {
        await removeKnowledgeSource(source);
        setSources(current => current.filter(s => s !== source));
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Impossible de retirer ce document.', 'negative');
      }
    },
    [notify],
  );

  return (
    <div className="border-t border-gray-800">
      <button
        id="oa-knowledge-toggle"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-gray-200"
      >
        <span>📚 Base de connaissances</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          {sources.length === 0 ? (
            <div data-testid="oa-knowledge-empty" className="px-1 pb-1 text-xs text-gray-600">
              Aucun document
            </div>
          ) : (
            <div className="flex flex-col gap-1 pb-1">
              {sources.map(source => (
                <div key={source} data-testid="oa-knowledge-entry" className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                  <span className="truncate text-xs text-gray-400" title={source}>
                    {source}
                  </span>
                  <button
                    data-testid="oa-knowledge-remove"
                    onClick={() => void handleRemove(source)}
                    className="shrink-0 text-xs text-gray-500 hover:text-red-400"
                    title="Retirer"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            id="oa-knowledge-add-btn"
            onClick={() => void handleAdd()}
            disabled={adding}
            className="w-full rounded border border-purple-900 bg-transparent py-1 text-xs text-purple-400 disabled:opacity-60"
          >
            {adding ? '…' : '+ Ajouter un document'}
          </button>
        </div>
      )}
    </div>
  );
}
