import { useEffect, useState } from 'react';
import { getGlobalSettings, saveGlobalSettings } from '../ipc/bridge';
import { useActionRegistry } from '../state/ActionRegistry';
import { SHORTCUTS, shouldShowOnboarding, stepAfter, type OnboardingStep } from '../state/onboarding';
import { Modal } from './settings/Modal';

// onboarding.py::onboarding_wizard: a persistent window (no Escape, no click on the backdrop) walking through
// four steps on the first launch. "Open the model settings" and "Open a folder" trigger the real windows through
// the same registry the command palette uses; the wizard is mounted BEFORE the rest of the app (see App.tsx) so
// the selector it opens is stacked above it. The end writes `onboarding_done`.
const persistent = () => { /* the wizard cannot be dismissed: only "Commencer à coder" ends it */ };

const primary = 'w-full rounded-lg bg-purple-600 px-3 py-2 text-sm font-semibold text-white hover:bg-purple-500';
const secondary = 'rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700';
const ghost = 'rounded-lg bg-transparent px-3 py-2 text-sm text-gray-400 hover:text-white';

export function Onboarding({ activeFolder }: { activeFolder: string | null }) {
  const registry = useActionRegistry();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A settings file that cannot be read must never lock the app behind a dialog: no answer = no wizard.
    getGlobalSettings().then(
      settings => { if (!cancelled) setVisible(shouldShowOnboarding(settings)); },
      () => { /* stay hidden */ },
    );
    return () => { cancelled = true; };
  }, []);

  if (!visible) return null;

  const go = (direction: 'next' | 'back') => setStep(current => stepAfter(current, direction));

  const finish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveGlobalSettings({ onboarding_done: true });
      setVisible(false);
    } catch (error) {
      // Closing anyway would bring the wizard back at every launch with no explanation.
      setSaveError(error instanceof Error ? error.message : 'Impossible d’enregistrer');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={persistent} width={384}>
      <div data-testid="oa-onboarding" data-step={step} className="flex flex-col gap-3 p-2">
        {step === 'welcome' && (
          <>
            <div className="text-xl font-bold">👋 Bienvenue dans OpenAgentic Skyzer !</div>
            <div className="text-sm text-gray-400">Un agent IA local, puissant et privé. Ce wizard vous guide en quatre étapes.</div>
            <button id="oa-onboarding-start" type="button" onClick={() => go('next')} className={`${primary} mt-4`}>Commencer →</button>
          </>
        )}
        {step === 'model' && (
          <>
            <div className="text-lg font-bold">🤖 Choisissez votre modèle</div>
            <div className="text-sm text-gray-400">Configurez le fournisseur et le modèle à utiliser.</div>
            <button id="oa-onboarding-model-open" type="button" onClick={() => registry.run('switch-model')} className={`${secondary} mt-2 w-full`}>
              ⚙️ Ouvrir les paramètres du modèle
            </button>
            <div className="mt-4 flex justify-between">
              <button id="oa-onboarding-back" type="button" onClick={() => go('back')} className={ghost}>← Retour</button>
              <button id="oa-onboarding-next" type="button" onClick={() => go('next')} className={secondary}>Suivant →</button>
            </div>
          </>
        )}
        {step === 'folder' && (
          <>
            <div className="text-lg font-bold">📁 Ouvrez un projet</div>
            <div className="text-sm text-gray-400">Le dossier actif permet à l'agent de connaître votre code.</div>
            <button id="oa-onboarding-folder-open" type="button" onClick={() => registry.run('open-folder')} className={`${secondary} mt-2 w-full`}>
              📂 Ouvrir un dossier
            </button>
            <div className="mt-4 flex justify-between">
              <button id="oa-onboarding-back" type="button" onClick={() => go('back')} className={ghost}>← Retour</button>
              {/* "Passer" in the original; once a folder is open there is nothing left to skip. */}
              <button id="oa-onboarding-next" type="button" onClick={() => go('next')} className={activeFolder ? secondary : ghost}>
                {activeFolder ? 'Suivant →' : 'Passer'}
              </button>
            </div>
          </>
        )}
        {step === 'done' && (
          <>
            <div className="text-xl font-bold">🎉 C'est parti !</div>
            <div className="text-sm text-gray-400">Quelques raccourcis utiles :</div>
            <div data-testid="oa-onboarding-shortcuts" className="mt-2 flex flex-col gap-1 font-mono text-xs">
              {SHORTCUTS.map(shortcut => <div key={shortcut.keys}>{shortcut.keys} — {shortcut.label}</div>)}
            </div>
            {saveError && <div data-testid="oa-onboarding-error" className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">{saveError}</div>}
            <button id="oa-onboarding-finish" type="button" disabled={saving} onClick={() => void finish()} className={`${primary} mt-4 disabled:opacity-60`}>
              Commencer à coder 🚀
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
