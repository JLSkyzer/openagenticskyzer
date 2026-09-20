export interface Command {
  id: string;
  label: string;
  description: string;
}

// command_palette.py::_COMMANDS — same labels, descriptions and order. "⬇ Exporter la conversation" is not
// here yet: the export does not exist in this app, and the original's own rule is to never show an entry
// whose action would do nothing. It comes back with the export.
export const COMMANDS: readonly Command[] = [
  { id: 'open-folder', label: '📂 Ouvrir un dossier', description: 'Sélectionner un nouveau dossier de projet' },
  { id: 'switch-model', label: '🔄 Changer de modèle', description: 'Ouvrir le sélecteur de modèle' },
  { id: 'clear-history', label: "🗑️ Vider l'historique", description: 'Effacer tous les messages du dossier actif' },
  { id: 'open-settings', label: '⚙️ Paramètres', description: "Ouvrir les paramètres de l'application" },
  { id: 'show-memory', label: '🧠 Voir la mémoire projet', description: 'Afficher la mémoire persistante de ce projet' },
  { id: 'open-prompts', label: '📋 Bibliothèque de prompts', description: 'Ouvrir la bibliothèque de prompts' },
  { id: 'compact', label: '⚡ Compacter le contexte', description: 'Résumer la conversation pour libérer du contexte' },
];

export const MAX_RESULTS = 8;

// command_palette.py::_match_commands: case-insensitive substring of the label OR the description, at most 8.
export function matchCommands(commands: readonly Command[], query: string): Command[] {
  const needle = (query || '').toLowerCase();
  return commands
    .filter(command => command.label.toLowerCase().includes(needle) || command.description.toLowerCase().includes(needle))
    .slice(0, MAX_RESULTS);
}

// memory.md marks each batch of facts with a dated HTML comment ("<!-- 2026-09-23 10:00 -->"). The NiceGUI
// window rendered the file as HTML, where a comment is invisible; the Markdown renderer here would print it
// as text. Only CLOSED comments go: an unclosed one is ordinary text and swallowing the rest would hide facts.
export function displayMemory(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\n/, '');
}

// Keyboard selection (an addition: the original palette only answers to the mouse). Wraps at both ends;
// -1 means "nothing to select".
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return (((current + delta) % count) + count) % count;
}

// Ctrl+K (Cmd+K on a Mac). Shift and Alt are refused: Ctrl+Shift+K is another shortcut, and Ctrl+Alt is how
// many keyboards type AltGr.
export function isPaletteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}
