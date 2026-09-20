import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionRegistry } from '../renderer-src/src/state/action-registry.ts';
import { MAX_TOASTS, dropToast, pushToast, type Toast } from '../renderer-src/src/state/toasts.ts';

test('a registered action runs, and run() says it was handled', () => {
  const registry = new ActionRegistry();
  let calls = 0;
  registry.register('open-folder', () => { calls++; });
  assert.equal(registry.run('open-folder'), true);
  assert.equal(calls, 1);
});

test('running an action nobody registered is reported, not silently ignored', () => {
  assert.equal(new ActionRegistry().run('open-model'), false);
});

test('unregistering removes the action', () => {
  const registry = new ActionRegistry();
  const unregister = registry.register('open-prompts', () => {});
  unregister();
  assert.equal(registry.run('open-prompts'), false);
});

test('the latest registration wins, and an older one unregistering later does not remove it', () => {
  // A component re-rendered or remounted registers again before the previous cleanup has run.
  const registry = new ActionRegistry();
  const seen: string[] = [];
  const first = registry.register('open-model', () => { seen.push('first'); });
  registry.register('open-model', () => { seen.push('second'); });
  first();
  assert.equal(registry.run('open-model'), true, 'the newer handler is still there');
  assert.deepEqual(seen, ['second']);
});

test('an action that throws does not leave the registry unusable', () => {
  const registry = new ActionRegistry();
  registry.register('boom', () => { throw new Error('échec'); });
  assert.throws(() => registry.run('boom'), /échec/);
  registry.register('ok', () => {});
  assert.equal(registry.run('ok'), true);
});

const toast = (id: number): Toast => ({ id, text: `t${id}`, kind: 'positive' });

test('toasts stack, and only the newest few are kept', () => {
  assert.equal(MAX_TOASTS, 3);
  let list: Toast[] = [];
  for (const id of [1, 2, 3, 4, 5]) list = pushToast(list, toast(id));
  assert.deepEqual(list.map(t => t.id), [3, 4, 5]);
});

test('a toast is dropped by its id, the others stay', () => {
  const list = [toast(1), toast(2), toast(3)];
  assert.deepEqual(dropToast(list, 2).map(t => t.id), [1, 3]);
  assert.deepEqual(dropToast(list, 99).map(t => t.id), [1, 2, 3], 'an unknown id changes nothing');
});
