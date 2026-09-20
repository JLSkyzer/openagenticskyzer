import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, isPaletteShortcut, matchCommands, moveSelection, MAX_RESULTS } from '../renderer-src/src/state/commands.ts';

const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `Commande ${i}`, description: `Fait le travail ${i}` }));

test('the palette offers the commands of the NiceGUI palette, in the same order (export left out until it exists)', () => {
  assert.deepEqual(COMMANDS.map(c => c.label), [
    '📂 Ouvrir un dossier',
    '🔄 Changer de modèle',
    "🗑️ Vider l'historique",
    '⚙️ Paramètres',
    '🧠 Voir la mémoire projet',
    '📋 Bibliothèque de prompts',
    '⚡ Compacter le contexte',
  ]);
  assert.equal(COMMANDS.some(c => /Exporter/.test(c.label)), false, 'no entry whose action would do nothing');
});

test('every command has a unique id, a label and a description', () => {
  assert.equal(new Set(COMMANDS.map(c => c.id)).size, COMMANDS.length);
  for (const command of COMMANDS) assert.ok(command.id && command.label && command.description, command.id);
});

test('matchCommands: an empty query lists everything', () => {
  assert.equal(matchCommands(COMMANDS, '').length, COMMANDS.length);
  assert.equal(matchCommands(COMMANDS, undefined as unknown as string).length, COMMANDS.length);
});

test('matchCommands looks in the label OR the description, ignoring case', () => {
  assert.deepEqual(matchCommands(COMMANDS, 'DOSSIER').map(c => c.id), ['open-folder', 'clear-history'], 'the label of one, the description of the other');
  assert.deepEqual(matchCommands(COMMANDS, 'persistante').map(c => c.id), ['show-memory'], 'description only');
  assert.deepEqual(matchCommands(COMMANDS, 'compacter').map(c => c.id), ['compact'], 'label only');
});

test('matchCommands gives an empty list when nothing matches', () => {
  assert.deepEqual(matchCommands(COMMANDS, 'zzzz'), []);
});

test('matchCommands returns at most 8 results (as _match_commands does)', () => {
  assert.equal(MAX_RESULTS, 8);
  assert.equal(matchCommands(many, '').length, 8);
  assert.deepEqual(matchCommands(many, 'commande').map(c => c.id), many.slice(0, 8).map(c => c.id), 'the first 8, in order');
});

test('moveSelection moves by one and wraps around the ends', () => {
  assert.equal(moveSelection(0, 1, 5), 1);
  assert.equal(moveSelection(4, 1, 5), 0, 'past the last goes back to the first');
  assert.equal(moveSelection(0, -1, 5), 4, 'before the first goes to the last');
  assert.equal(moveSelection(2, -1, 5), 1);
});

test('moveSelection with nothing to select stays on "none"', () => {
  assert.equal(moveSelection(0, 1, 0), -1);
  assert.equal(moveSelection(-1, -1, 0), -1);
});

test('isPaletteShortcut: Ctrl+K or Cmd+K only, whatever the case of the key', () => {
  const key = (init: object) => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
  assert.equal(isPaletteShortcut(key({ ctrlKey: true })), true);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, key: 'K' })), true, 'caps lock');
  assert.equal(isPaletteShortcut(key({ metaKey: true })), true);
  assert.equal(isPaletteShortcut(key({})), false, 'K alone is just a letter');
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, key: 'j' })), false);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+K is another shortcut');
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, altKey: true })), false, 'Ctrl+Alt is AltGr on many keyboards');
});
