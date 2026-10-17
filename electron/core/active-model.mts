// The ONE place that decides which model answers: active_local_model (global config.json), resolved through the
// .gguf library. The worker reads it itself on every send and compaction; an id sent by the page is never used.
import type { SettingsService } from './settings.mts';
import type { GgufEntry, GgufLibrary } from './gguf-library.mts';
import { loadedContextSize } from './local-engine.mts';
import { MIN_LOCAL_CONTEXT } from './context-budget.mts';

export const NO_LOCAL_MODEL = 'Aucun modèle local actif : ajoute ou choisis un fichier .gguf (bouton du modèle).';
export const LOCAL_MODEL_MISSING = 'Modèle local introuvable : il a peut-être été retiré de la bibliothèque. Choisis-en un autre.';

export interface ActiveModel { id: string; name: string; path: string }
export interface ModelStatus { id: string; name: string | null; missing: boolean; contextWindow: number; loaded: boolean }

/** The saved id ('' when none) and its library entry (null when the id is unknown or its file is gone). */
async function lookup(settings: SettingsService, library: GgufLibrary): Promise<{ id: string; entry: GgufEntry | null }> {
  const saved = (await settings.global()).active_local_model;
  const id = typeof saved === 'string' ? saved : '';
  if (!id) return { id, entry: null };
  return { id, entry: (await library.list()).find(entry => entry.id === id) ?? null };
}

/** The active model; null when none is set. Throws LOCAL_MODEL_MISSING when one is set but its file is gone (moved,
 * deleted, or removed from the library). */
export async function activeModel(settings: SettingsService, library: GgufLibrary): Promise<ActiveModel | null> {
  const { id, entry } = await lookup(settings, library);
  if (!id) return null;
  if (!entry) throw new Error(LOCAL_MODEL_MISSING);
  return { id, name: entry.name, path: entry.path };
}

/** What the page shows of the model. The window is the engine's real context size once that model is loaded, else
 * MIN_LOCAL_CONTEXT; reading it never loads anything. */
export async function modelStatus(settings: SettingsService, library: GgufLibrary): Promise<ModelStatus> {
  const { id, entry } = await lookup(settings, library);
  const size = entry ? loadedContextSize(entry.path) : null;
  return { id, name: entry?.name ?? null, missing: Boolean(id) && !entry, contextWindow: size ?? MIN_LOCAL_CONTEXT, loaded: size !== null };
}

/** What the 'model' event of a turn reports: the model that turn resolved before it started (null on the test seam),
 * never a fresh read of the setting — the user may pick another one while the turn runs. Pure and synchronous. */
export function turnModelStatus(model: ActiveModel | null): ModelStatus {
  const size = model ? loadedContextSize(model.path) : null;
  return { id: model?.id ?? '', name: model?.name ?? null, missing: false, contextWindow: size ?? MIN_LOCAL_CONTEXT, loaded: size !== null };
}
