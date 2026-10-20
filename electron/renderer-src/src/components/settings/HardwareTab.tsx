import { useCallback, useEffect, useState } from 'react';
import { getHardwareInfo, type HardwareInfo } from '../../ipc/bridge';
import { cleanIpcError } from '../../ipc/errors';
import type { LocalContextSetting } from '../../../../core/context-budget.mts';
import { hardwareLines, LOCAL_CONTEXT_OPTIONS } from './hardware-view';
import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section } from './parts';

// « 🖥️ Matériel »: what the machine offers to the built-in engine (read-only, re-readable) and the global
// « Contexte des modèles locaux » setting, saved by « Enregistrer » like every other tab.
export function HardwareTab({ draft }: { draft: SettingsDraft }) {
  const [info, setInfo] = useState<HardwareInfo | null>(null);
  const [reads, setReads] = useState(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((refresh: boolean) => {
    setReading(true);
    setError(null);
    return getHardwareInfo(refresh)
      .then(value => {
        setInfo(value);
        setReads(count => count + 1);
      })
      .catch(error_ => setError(cleanIpcError(error_)))
      .finally(() => setReading(false));
  }, []);
  useEffect(() => { void read(false); }, [read]);

  const localContext = draft.get<LocalContextSetting>('local_context', 32768);

  return (
    <div className="flex flex-col gap-5">
      <div data-testid="oa-hardware" data-reads={reads}>
        <Section title="Matériel" badge="GLOBAL" />
        <Group>
          <div className="flex flex-col gap-1 px-4 py-3">
            {info === null && !error && <span className="text-xs text-gray-600">Lecture du matériel…</span>}
            {info !== null && hardwareLines(info).map(line => (
              <span
                key={line.field}
                data-testid="oa-hardware-line"
                data-field={line.field}
                className={'text-xs ' + (line.field === 'notice' ? 'text-yellow-600' : 'text-gray-300')}
              >
                {line.text}
              </span>
            ))}
            {error && <span data-testid="oa-hardware-error" className="text-xs text-red-400">{error}</span>}
            <button
              type="button"
              data-testid="oa-hardware-refresh-btn"
              disabled={reading}
              onClick={() => void read(true)}
              className="mt-2 self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300 hover:border-purple-500 disabled:opacity-60"
            >
              Relire
            </button>
          </div>
        </Group>
      </div>
      <div>
        <Group>
          <Row
            label="Contexte des modèles locaux"
            hint="Plafonné par ce que le modèle supporte et par la limite de contexte (Contexte & Mémoire). Changer la valeur recharge le modèle au message suivant."
            last
          >
            <select
              data-setting="local_context"
              value={String(localContext)}
              onChange={event => draft.set('local_context', event.target.value === 'max' ? 'max' : Number(event.target.value))}
              className="w-36 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            >
              {LOCAL_CONTEXT_OPTIONS.map(option => (
                <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
              ))}
            </select>
          </Row>
        </Group>
      </div>
    </div>
  );
}
