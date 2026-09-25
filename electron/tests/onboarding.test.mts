import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, STEPS, shouldShowOnboarding, stepAfter } from '../renderer-src/src/state/onboarding.ts';

test('the wizard has the four steps of onboarding.py, in order', () => {
  assert.deepEqual([...STEPS], ['welcome', 'model', 'folder', 'done']);
});

test('shouldShowOnboarding: only a settings answer that says it is not done shows the wizard', () => {
  assert.equal(shouldShowOnboarding({ onboarding_done: false }), true);
  assert.equal(shouldShowOnboarding({}), true, 'absent = not done, like `.get("onboarding_done", False)`');
  assert.equal(shouldShowOnboarding({ onboarding_done: true }), false);
});

test('shouldShowOnboarding never blocks the app: no answer (a failed read) means no wizard', () => {
  assert.equal(shouldShowOnboarding(null), false);
});

test('shouldShowOnboarding reads a non-boolean value like Python\'s bool(): only truthy means done', () => {
  assert.equal(shouldShowOnboarding({ onboarding_done: 1 }), false);
  assert.equal(shouldShowOnboarding({ onboarding_done: 'oui' }), false);
  assert.equal(shouldShowOnboarding({ onboarding_done: 0 }), true);
  assert.equal(shouldShowOnboarding({ onboarding_done: null }), true);
  assert.equal(shouldShowOnboarding({ onboarding_done: '' }), true);
});

test('stepAfter moves one step and stays inside the wizard', () => {
  assert.equal(stepAfter('welcome', 'next'), 'model');
  assert.equal(stepAfter('model', 'next'), 'folder');
  assert.equal(stepAfter('folder', 'next'), 'done');
  assert.equal(stepAfter('done', 'next'), 'done', 'no step after the last');
  assert.equal(stepAfter('done', 'back'), 'folder');
  assert.equal(stepAfter('model', 'back'), 'welcome');
  assert.equal(stepAfter('welcome', 'back'), 'welcome', 'no step before the first');
});

test('the shortcuts shown are the ones this app really has — none of the original\'s three that do not exist or are wrong', () => {
  const keys = SHORTCUTS.map(shortcut => shortcut.keys);
  assert.deepEqual(keys, ['Ctrl+K', 'Entrée', 'Shift+Entrée']);
  for (const invented of ['Ctrl+L', 'Ctrl+,', 'Ctrl+Entrée']) assert.equal(keys.includes(invented), false, invented);
  assert.match(SHORTCUTS[1].label, /Envoyer/);
  assert.match(SHORTCUTS[2].label, /ligne/i);
});
