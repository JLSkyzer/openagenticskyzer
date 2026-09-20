import type { PromptEntry } from '../ipc/types';

// prompt_library.py::_filter: case-insensitive, on the NAME and the DESCRIPTION only (not the template).
// The query is used as typed, without trimming, like the original.
export function filterPrompts(prompts: readonly PromptEntry[], query: string): PromptEntry[] {
  const needle = (query || '').toLowerCase();
  return prompts.filter(prompt => prompt.name.toLowerCase().includes(needle) || prompt.description.toLowerCase().includes(needle));
}

// prompt_library.py::_apply: Path(active_folder).name, "projet" when there is none. A trailing separator is
// tolerated and a drive root ("D:\") has no name, exactly the cases the original comments on.
export function folderLabel(folder: string | null | undefined): string {
  const segments = (folder ?? '').split(/[\\/]+/).filter(segment => segment.trim() !== '');
  const last = segments.at(-1) ?? '';
  return last && !/^[A-Za-z]:$/.test(last) ? last : 'projet';
}

// Every {filename} becomes the folder name. split/join rather than replace: the name is inserted
// literally, a "$&" or "$1" in a folder name is not a replacement pattern.
export function applyTemplate(template: string, folder: string | null | undefined): string {
  return template.split('{filename}').join(folderLabel(folder));
}
