import { useEffect, useState, type ReactNode } from 'react';
import { AppearanceTab } from './AppearanceTab';
import { ContextTab } from './ContextTab';
import { GeneralTab } from './GeneralTab';
import { PermissionsTab } from './PermissionsTab';
import { Placeholder, Section } from './parts';
import { useSettingsDraft } from './useSettingsDraft';

type TabId = 'general' | 'appearance' | 'context' | 'permissions' | 'tools' | 'folder' | 'danger';

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// Layout copied from settings.py: maximized dialog, 200px left rail (#111) with a
// "Paramètres" header and 7 vertical tabs, scrollable content on the right with the
// Enregistrer / Fermer footer at its end.
export function SettingsDialog({ activeFolder, onClose }: { activeFolder: string | null; onClose(): void }) {
  const [tab, setTab] = useState<TabId>('general');
  const draft = useSettingsDraft();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'general', label: '🌐 Général' },
    { id: 'appearance', label: '🎨 Apparence' },
    { id: 'context', label: '🧠 Contexte & Mémoire' },
    { id: 'permissions', label: '🔒 Permissions' },
    { id: 'tools', label: '🧩 Outils' },
    { id: 'folder', label: `📁 ${activeFolder ? basename(activeFolder) : 'Dossier'}` },
    { id: 'danger', label: '⚠️ Danger' },
  ];

  // Tabs without controls yet get theirs in the following tasks of this lot.
  const panels: Record<TabId, ReactNode> = {
    general: <GeneralTab draft={draft} />,
    appearance: <AppearanceTab />,
    context: <ContextTab draft={draft} activeFolder={activeFolder} />,
    permissions: <PermissionsTab draft={draft} />,
    tools: <TabStub title="Outils" badge="EXTENSIONS" />,
    folder: <TabStub title="Dossier" badge="DOSSIER" />,
    danger: <TabStub title="Zone Danger" />,
  };

  return (
    <div
      data-testid="oa-settings-dialog"
      className="fixed inset-0 z-50 flex"
      style={{ background: '#0d0d0d', gap: 0 }}
    >
      <div
        data-testid="oa-settings-rail"
        className="flex shrink-0 flex-col py-4"
        style={{ width: 200, background: '#111', borderRight: '1px solid #1e1e1e' }}
      >
        <div className="px-4 pb-2 text-xs uppercase tracking-widest text-gray-600">Paramètres</div>
        {tabs.map(entry => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              data-testid="oa-settings-tab"
              data-tab={entry.id}
              data-active={active}
              onClick={() => setTab(entry.id)}
              className={
                'block w-full truncate border-l-2 px-4 py-2 text-left text-xs ' +
                (active ? 'border-purple-500 bg-indigo-950 text-purple-300' : 'border-transparent text-gray-400 hover:bg-gray-900')
              }
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div className="h-full flex-1 overflow-y-auto p-8">
        <div data-testid="oa-settings-panel" data-tab={tab}>
          {draft.loaded ? panels[tab] : null}
        </div>
        <div className="mt-6 flex items-center gap-2">
          <button
            id="oa-settings-save-btn"
            onClick={() => void draft.save()}
            disabled={!draft.loaded || draft.saving}
            className="rounded-lg bg-purple-600 px-4 py-2 text-xs text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Enregistrer
          </button>
          <button
            id="oa-settings-close-btn"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700"
          >
            Fermer
          </button>
          {draft.status && (
            <span data-testid="oa-settings-status" className="text-xs text-green-500">
              {draft.status}
            </span>
          )}
          {draft.error && (
            <span data-testid="oa-settings-error" className="text-xs text-red-400">
              {draft.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TabStub({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title={title} badge={badge} />
      <Placeholder text="Les contrôles de cet onglet arrivent avec les prochaines tâches du lot — à venir." />
    </div>
  );
}
