import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROMPTS, type DefaultPrompt } from './prompt-defaults.mts';

export { DEFAULT_PROMPTS };
export type Prompt = DefaultPrompt;

const DEFAULT_ICON = '📝';
// A hand-written prompt file is tiny; anything bigger is not one and is not worth loading.
const MAX_BYTES = 1_000_000;

const copyOfDefaults = (): Prompt[] => DEFAULT_PROMPTS.map(prompt => ({ ...prompt }));

// storage.py::load_prompts required a list of objects holding id, name and template; it never checked
// their types, so a numeric name crashed the picker's filter. Types are checked here. One bad entry
// rejects the whole file — the same all-or-nothing rule as the original.
function parse(raw: unknown): Prompt[] | null {
  if (!Array.isArray(raw)) return null;
  const prompts: Prompt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { id, name, template, icon, description } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof template !== 'string') return null;
    if (icon !== undefined && typeof icon !== 'string') return null;
    if (description !== undefined && typeof description !== 'string') return null;
    prompts.push({ id, name, template, icon: icon ?? DEFAULT_ICON, description: description ?? '' });
  }
  return prompts;
}

/**
 * The prompt library: the ten defaults, or the user's own `prompts.json` from the data directory when it
 * is valid. The file is read on every call so a hand edit needs no restart; nothing is ever written.
 */
export class PromptLibrary {
  private file: string;
  constructor(home: string) { this.file = join(home, 'prompts.json'); }

  async list(): Promise<Prompt[]> {
    try {
      if ((await stat(this.file)).size > MAX_BYTES) return copyOfDefaults();
      return parse(JSON.parse(await readFile(this.file, 'utf8'))) ?? copyOfDefaults();
    } catch {
      // Absent, unreadable or not JSON: same fallback as the original, and never an error for the picker.
      return copyOfDefaults();
    }
  }
}
