import { useCallback, useEffect, useState } from 'react';
import { getGlobalSettings, saveGlobalSettings } from '../../ipc/bridge';

type Values = Record<string, unknown>;

export interface SettingsDraft {
  loaded: boolean;
  saving: boolean;
  status: string | null;
  error: string | null;
  // The edited value if the user changed it, else the saved one, else the fallback.
  get<T>(key: string, fallback: T): T;
  // True when the backend already stores a value for a write-only key (e.g. hf_token).
  configured(key: string): boolean;
  set(key: string, value: unknown): void;
  save(): Promise<void>;
}

// Electron prefixes rejected IPC calls with "Error invoking remote method '…': Error: " —
// strip it so the user sees the backend's own message.
function cleanMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

// Mirrors settings.py's `cfg` dict, but only the keys the user actually touched are sent on
// save, so an untouched key is never rewritten (and the write-only token never round-trips).
export function useSettingsDraft(): SettingsDraft {
  const [saved, setSaved] = useState<Values>({});
  const [edits, setEdits] = useState<Values>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGlobalSettings()
      .then(values => {
        if (cancelled) return;
        setSaved(values);
        setLoaded(true);
      })
      .catch(reason => {
        if (cancelled) return;
        setError(cleanMessage(reason));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const get = useCallback(
    <T,>(key: string, fallback: T): T => {
      if (key in edits) return edits[key] as T;
      const value = saved[key];
      return value === undefined || value === null ? fallback : (value as T);
    },
    [edits, saved],
  );

  const configured = useCallback((key: string) => saved[`${key}_configured`] === true, [saved]);

  const set = useCallback(
    (key: string, value: unknown) => {
      setStatus(null);
      setError(null);
      setEdits(current => {
        const next = { ...current };
        // Back to the stored value (or an emptied write-only field) means "no change".
        if (saved[key] === value || (key === 'hf_token' && value === '')) delete next[key];
        else next[key] = value;
        return next;
      });
    },
    [saved],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const result = Object.keys(edits).length > 0 ? await saveGlobalSettings(edits) : saved;
      setSaved(result);
      setEdits({});
      setStatus('Paramètres sauvegardés.');
    } catch (reason) {
      setError(cleanMessage(reason));
    } finally {
      setSaving(false);
    }
  }, [edits, saved]);

  return { loaded, saving, status, error, get, configured, set, save };
}
