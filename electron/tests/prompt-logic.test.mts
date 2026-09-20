import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, filterPrompts, folderLabel } from '../renderer-src/src/state/prompts.ts';

const prompts = [
  { id: 'refactor', name: 'Refactoriser', icon: '🔧', description: 'Améliore la lisibilité et la structure du code', template: 'Refactorise {filename}' },
  { id: 'tests', name: 'Écrire les tests', icon: '🧪', description: 'Génère des tests unitaires', template: 'Écris des tests pour {filename}' },
  { id: 'sec', name: 'Audit sécurité', icon: '🔒', description: 'Cherche les vulnérabilités', template: 'Cherche des injections OWASP' },
];

test('an empty filter keeps every prompt, in order', () => {
  assert.deepEqual(filterPrompts(prompts, '').map(p => p.id), ['refactor', 'tests', 'sec']);
  assert.deepEqual(filterPrompts(prompts, undefined as unknown as string).map(p => p.id), ['refactor', 'tests', 'sec']);
});

test('the filter looks in the name and in the description, ignoring case', () => {
  assert.deepEqual(filterPrompts(prompts, 'REFACT').map(p => p.id), ['refactor'], 'name, any case');
  assert.deepEqual(filterPrompts(prompts, 'vulnérabilités').map(p => p.id), ['sec'], 'description');
  assert.deepEqual(filterPrompts(prompts, 'tests').map(p => p.id), ['tests'], 'both the name and the description match: listed once');
});

test('the filter does NOT look in the template (prompt_library.py only searches name and description)', () => {
  assert.deepEqual(filterPrompts(prompts, 'owasp'), []);
  assert.deepEqual(filterPrompts(prompts, 'zzz'), []);
});

test('the query is used as typed: a leading space is part of it, as in the original', () => {
  // "Refactoriser" starts the name and nothing holds " refact": with the space it matches nothing.
  assert.deepEqual(filterPrompts(prompts, 'refact').map(p => p.id), ['refactor']);
  assert.deepEqual(filterPrompts(prompts, ' refact').map(p => p.id), [], 'the space is not trimmed away');
  assert.deepEqual(filterPrompts(prompts, 'les tests').map(p => p.id), ['tests'], 'inner spaces are part of the query too');
});

test('folderLabel is the last segment of the folder path, a trailing separator tolerated (Path(...).name)', () => {
  assert.equal(folderLabel('D:\\projects\\myapp'), 'myapp');
  assert.equal(folderLabel('D:\\projects\\myapp\\'), 'myapp', 'the case the original comments about');
  assert.equal(folderLabel('/home/killian/app/'), 'app');
  assert.equal(folderLabel('/home/killian/app'), 'app');
  assert.equal(folderLabel('\\\\serveur\\partage'), 'partage');
});

test('folderLabel falls back on "projet" when there is no usable name', () => {
  for (const folder of [null, undefined, '', 'D:\\', 'D:', '/', '\\', '   ']) {
    assert.equal(folderLabel(folder as string | null), 'projet', JSON.stringify(folder));
  }
});

test('applyTemplate replaces every {filename} with the folder name', () => {
  assert.equal(applyTemplate('Refactorise {filename} puis teste {filename}', 'D:\\projects\\myapp'), 'Refactorise myapp puis teste myapp');
  assert.equal(applyTemplate('Analyse cette erreur :\n\n', 'D:\\projects\\myapp'), 'Analyse cette erreur :\n\n', 'a template without the placeholder is kept as it is, trailing blank lines included');
  assert.equal(applyTemplate('Traduis {filename}', null), 'Traduis projet');
});

test('applyTemplate uses the folder name literally: "$&" and "$1" in a name are not replacement patterns', () => {
  assert.equal(applyTemplate('Fichier : {filename}', 'C:\\dev\\a$&b'), 'Fichier : a$&b');
  assert.equal(applyTemplate('Fichier : {filename}', 'C:\\dev\\x$1y'), 'Fichier : x$1y');
  assert.equal(applyTemplate('Fichier : {filename}', 'C:\\dev\\p$`q'), 'Fichier : p$`q');
});
