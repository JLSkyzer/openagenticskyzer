import { useCallback, useEffect, useMemo, useState } from 'react';
import { getGlobalSettings, getProjectSettings, saveGlobalSettings, saveProjectSettings } from '../../ipc/bridge';

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
  // Saves the pending edits.
  save(): Promise<void>;
  // Saves the pending edits together with `patch` right away (e.g. the prompt editor).
  // Resolves true when the backend accepted the save.
  commit(patch: Values): Promise<boolean>;
  // Discards edits and re-reads the stored values (after an external change).
  reload(): void;
}

interface DraftSource {
  load(): Promise<Values>;
  save(patch: Values): Promise<Values>;
}

// Electron prefixes rejected IPC calls with "Error invoking remote method '…': Error: " —
// strip it so the user sees the backend's own message.
function cleanMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

// Mirrors settings.py's `cfg` dict, but only the keys the user actually touched are sent on
// save, so an untouched key is never rewritten (and the write-only token never round-trips).
function useDraft(source: DraftSource, savedMessage: string): SettingsDraft {
  const [saved, setSaved] = useState<Values>({});
  const [edits, setEdits] = useState<Values>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    source
      .load()
      .then(values => {
        if (cancelled) return;
        setSaved(values);
        setEdits({});
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
  }, [source, reloadToken]);

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

  const commit = useCallback(
    async (patch: Values): Promise<boolean> => {
      setSaving(true);
      setStatus(null);
      setError(null);
      try {
        const merged = { ...edits, ...patch };
        const result = Object.keys(merged).length > 0 ? await source.save(merged) : saved;
        setSaved(result);
        setEdits({});
        setStatus(savedMessage);
        return true;
      } catch (reason) {
        setError(cleanMessage(reason));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [edits, saved, source, savedMessage],
  );

  const save = useCallback(async () => {
    await commit({});
  }, [commit]);
  const reload = useCallback(() => {
    setStatus(null);
    setError(null);
    setReloadToken(token => token + 1);
  }, []);

  return { loaded, saving, status, error, get, configured, set, save, commit, reload };
}

const GLOBAL_SOURCE: DraftSource = { load: () => getGlobalSettings(), save: patch => saveGlobalSettings(patch) };

export function useSettingsDraft(): SettingsDraft {
  return useDraft(GLOBAL_SOURCE, 'Paramètres sauvegardés.');
}

// Per-project settings (agent mode, ignored patterns, custom prompt) live in the
// project's own .openagent/config.json, not in the global config.
export function useProjectDraft(folder: string): SettingsDraft {
  const source = useMemo<DraftSource>(
    () => ({
      load: () => getProjectSettings(folder) as unknown as Promise<Values>,
      save: patch => saveProjectSettings(folder, patch) as unknown as Promise<Values>,
    }),
    [folder],
  );
  return useDraft(source, 'Paramètres dossier sauvegardés.');
}
