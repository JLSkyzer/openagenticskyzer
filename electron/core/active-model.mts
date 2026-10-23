// The ONE place that decides which model answers: active_local_model (global config.json), resolved through the
// .gguf library. The worker reads it itself on every send and compaction; an id sent by the page is never used.
import type { SettingsService } from './settings.mts';
import type { GgufEntry, GgufLibrary } from './gguf-library.mts';
import { loadedContextSize, loadedPlacement, plannedContextSize, type ContextRequest } from './local-engine.mts';
import { MIN_LOCAL_CONTEXT } from './context-budget.mts';
import { llamaCreated } from './llama-runtime.mts';
import { estimateKey, hardwareKey, type EstimateCache } from './offload-estimate.mts';
import type { Placement } from './placement.mts';

export const NO_LOCAL_MODEL = 'Aucun modèle local actif : ajoute ou choisis un fichier .gguf (bouton du modèle).';
export const LOCAL_MODEL_MISSING = 'Modèle local introuvable : il a peut-être été retiré de la bibliothèque. Choisis-en un autre.';

export interface ActiveModel { id: string; name: string; path: string }
/** `placement` is omitted when unknown: the loaded truth once that model is loaded, else the cached estimate. */
/** `replacing`: added by worker.mjs while the model is reloaded between turns to put more layers on the card. */
export interface ModelStatus { id: string; name: string | null; missing: boolean; contextWindow: number; loaded: boolean; placement?: Placement; replacing?: boolean }

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

/** The engine context request the global settings ask for (« Contexte des modèles locaux »). */
export async function contextRequestOf(settings: SettingsService): Promise<ContextRequest> {
  return { setting: (await settings.global()).local_context as ContextRequest['setting'] };
}

/** The window planned for `path` before it loads; MIN_LOCAL_CONTEXT when the file cannot be read. */
async function plannedWindow(path: string, request: ContextRequest): Promise<number> {
  try {
    return await plannedContextSize(path, request);
  } catch {
    return MIN_LOCAL_CONTEXT;
  }
}

/** The cached estimate for `path` at `contextSize` on this machine, or null. Only once the Llama exists: reading the
 * hardware key would otherwise create it, and model-status never does. Never computes an estimate. */
async function cachedEstimate(cache: EstimateCache, path: string, contextSize: number): Promise<Placement | null> {
  if (!llamaCreated()) return null;
  try {
    return await cache.get(await estimateKey({ kind: 'file', path }, contextSize, await hardwareKey()));
  } catch {
    return null;
  }
}

/** What the page shows of the model. The window is the engine's real context size once that model is loaded, else
 * the size it will be loaded with (the setting capped by the file's train size); reading it never loads anything.
 * The placement of a loaded model is where it really sits (loadedPlacement): an estimate of it now would be skewed by
 * the model's own VRAM. Before a load, it is the cached estimate (`cache`, the worker's one EstimateCache), if any. */
export async function modelStatus(settings: SettingsService, library: GgufLibrary, cache: EstimateCache): Promise<ModelStatus> {
  const { id, entry } = await lookup(settings, library);
  const size = entry ? loadedContextSize(entry.path) : null;
  const contextWindow = size ?? (entry ? await plannedWindow(entry.path, await contextRequestOf(settings)) : MIN_LOCAL_CONTEXT);
  const status: ModelStatus = { id, name: entry?.name ?? null, missing: Boolean(id) && !entry, contextWindow, loaded: size !== null };
  const placement = !entry ? null : size !== null ? loadedPlacement(entry.path) : await cachedEstimate(cache, entry.path, contextWindow);
  return placement ? { ...status, placement } : status;
}

/** What the 'model' event of a turn reports: the model that turn resolved before it started (null on the test seam),
 * never a fresh read of the setting — the user may pick another one while the turn runs. Pure and synchronous: the
 * placement is the loaded one, or omitted. */
export function turnModelStatus(model: ActiveModel | null): ModelStatus {
  const size = model ? loadedContextSize(model.path) : null;
  const status: ModelStatus = { id: model?.id ?? '', name: model?.name ?? null, missing: false, contextWindow: size ?? MIN_LOCAL_CONTEXT, loaded: size !== null };
  const placement = model ? loadedPlacement(model.path) : null;
  return placement ? { ...status, placement } : status;
}
