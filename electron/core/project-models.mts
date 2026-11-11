// The model chosen for each project (« Par défaut » or one .gguf of the library), kept in the user's data
// (<home>/project-models.json), never in the project: a repository downloaded from the internet cannot impose a model,
// so nothing here reads or writes the project's .openagent/. Keyed like the folders list (core/folders.mts): one
// folder under any spelling is one entry; a project moved or renamed starts again on the default model.
import { isAbsolute, join } from 'node:path';
import { canonicalFolderPath, folderKey } from './folders.mts';
import { JsonStore } from './json-store.mts';

type Choices = Record<string, string>;

/** The stored choices that can be read: string ids under their key; anything else counts for nothing. */
function choicesOf(raw: unknown): Choices {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, id]) => typeof id === 'string' && id.length > 0)) as Choices;
}

export class ProjectModels {
  private readonly file: string;
  private readonly store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.file = join(home, 'project-models.json');
  }

  /** The model id chosen for `folder`, or null (« Par défaut »). A relative folder has none: no choice is stored so. */
  async get(folder: string): Promise<string | null> {
    if (typeof folder !== 'string' || !isAbsolute(folder)) return null;
    const key = folderKey(await canonicalFolderPath(folder));
    return choicesOf(await this.store.read<unknown>(this.file, {}))[key] ?? null;
  }

  /** Chooses `modelId` for `folder`; null or '' goes back to the default model. */
  async set(folder: string, modelId: string | null): Promise<void> {
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Dossier absolu requis');
    if (modelId !== null && typeof modelId !== 'string') throw new Error('Identifiant de modèle invalide');
    const key = folderKey(await canonicalFolderPath(folder));
    // No .pre-electron.bak: this file has no older app's content to keep.
    await this.store.update<unknown>(this.file, {}, current => {
      const choices = choicesOf(current);
      if (modelId) choices[key] = modelId;
      else delete choices[key];
      return choices;
    }, { backup: false });
  }
}
