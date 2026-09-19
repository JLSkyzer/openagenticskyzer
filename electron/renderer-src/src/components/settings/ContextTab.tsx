import { useEffect, useState } from 'react';
import { getConnection } from '../../ipc/bridge';
import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section, Toggle } from './parts';

// utils.py::_DEFAULT_CTX_LIMITS — the maximum context of the active provider's models.
const CTX_LIMITS: Record<string, number> = {
  together: 128_000,
  groq: 128_000,
  mistral: 32_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  ollama: 32_000,
  lmstudio: 32_000,
  llamacpp: 32_000,
};
// Node's SettingsService rejects a context limit below 2048 (settings.py's slider started
// at 2000), so the smallest value the slider can produce is clamped to it.
const MIN_TOKENS = 2048;

const fmt = (n: number) => n.toLocaleString('en-US');

// Mirrors settings.py::_tab_context.
export function ContextTab({ draft, activeFolder }: { draft: SettingsDraft; activeFolder: string | null }) {
  const [provider, setProvider] = useState('ollama');
  useEffect(() => {
    let cancelled = false;
    getConnection(activeFolder)
      .then(snapshot => {
        if (!cancelled) setProvider(snapshot.provider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  const ctxMax = CTX_LIMITS[provider] ?? 32_000;
  const maxTokens = draft.get<number>('max_tokens', Math.floor(ctxMax / 2));
  const threshold = draft.get<number>('compact_threshold', 70);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Contexte & Mémoire" badge="GLOBAL" />
        <Group>
          <div className="flex flex-col gap-2 border-b border-gray-900 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Limite de contexte</span>
            <span data-testid="oa-ctx-caption" className="text-xs text-gray-500">
              Max du modèle actif ({provider}) : {fmt(ctxMax)} tokens
            </span>
            <input
              data-setting="max_tokens"
              type="range"
              min={2000}
              max={ctxMax}
              step={1000}
              value={maxTokens}
              onChange={event => draft.set('max_tokens', Math.max(MIN_TOKENS, Number(event.target.value)))}
              className="w-full accent-purple-500"
            />
            <span data-testid="oa-max-tokens-label" className="text-xs text-purple-400">
              {fmt(maxTokens)} tokens
            </span>
            {provider === 'ollama' && (
              <div className="flex items-start gap-2 rounded border border-yellow-900 p-2" style={{ background: '#1a1200' }}>
                <span className="text-sm">⚠️</span>
                <span className="text-xs text-yellow-600">Ollama : le contexte réel dépend de votre VRAM/RAM.</span>
              </div>
            )}
          </div>
          <Row label="Tokens réservés pour la réponse" hint="Espace toujours gardé libre pour la génération">
            <input
              data-setting="reserved_tokens"
              type="number"
              min={512}
              max={8192}
              step={256}
              value={draft.get<number>('reserved_tokens', 2048)}
              onChange={event => draft.set('reserved_tokens', Number(event.target.value))}
              className="w-24 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
          </Row>
          <Row label="Auto-compact" hint="Compresse l’historique avant d’atteindre la limite">
            <Toggle setting="auto_compact" checked={draft.get('auto_compact', true)} onChange={value => draft.set('auto_compact', value)} />
          </Row>
          <Row labelTestId="oa-threshold-label" label={`Seuil auto-compact : ${threshold}%`} hint="Déclenche la compression à ce % d’utilisation">
            <input
              data-setting="compact_threshold"
              type="range"
              min={40}
              max={95}
              step={5}
              value={threshold}
              onChange={event => draft.set('compact_threshold', Number(event.target.value))}
              className="w-32 accent-purple-500"
            />
          </Row>
          <Row label="Afficher la jauge de contexte">
            <Toggle setting="show_context_bar" checked={draft.get('show_context_bar', true)} onChange={value => draft.set('show_context_bar', value)} />
          </Row>
          <Row label="Rétention des sessions" hint="Durée de conservation de l’historique" last>
            <select
              data-setting="session_retention_days"
              value={draft.get<number>('session_retention_days', 30)}
              onChange={event => draft.set('session_retention_days', Number(event.target.value))}
              className="w-32 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            >
              <option value={7}>7 jours</option>
              <option value={30}>30 jours</option>
              <option value={90}>90 jours</option>
              <option value={0}>Indéfiniment</option>
            </select>
          </Row>
        </Group>
      </div>
    </div>
  );
}
