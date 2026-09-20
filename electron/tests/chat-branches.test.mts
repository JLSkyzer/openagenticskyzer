import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';
import { canForkAt, nextBranchLabel } from '../renderer-src/src/state/branches.ts';

const MAIN = { id: 'main', label: 'Principale', created_at: '2026-09-20T10:00:00.000Z', message_count: 4 };
const fork = (id: string, label: string) => ({ id, label, created_at: '2026-09-20T10:05:00.000Z', message_count: 1 });
const view = [
  { role: 'user', content: 'premier' },
  { role: 'assistant', content: 'réponse 1' },
  { role: 'user', content: 'second' },
  { role: 'assistant', content: 'réponse 2' },
] as const;

const running = (state: ChatState): ChatState => ({ ...state, agentRunning: true, runId: 'run-1' });

test('nextBranchLabel counts forks only, never main (same global counter as the NiceGUI app)', () => {
  assert.equal(nextBranchLabel([MAIN]), 'Branche 1');
  assert.equal(nextBranchLabel([MAIN, fork('a', 'Branche 1')]), 'Branche 2');
  assert.equal(nextBranchLabel([MAIN, fork('a', 'Branche 1'), fork('b', 'Branche 2')]), 'Branche 3');
  assert.equal(nextBranchLabel([]), 'Branche 1', 'no list loaded yet still yields a valid label');
});

test('canForkAt only accepts a user message whose persisted twin is identical', () => {
  const persisted = view.map(m => ({ ...m }));
  assert.equal(canForkAt(persisted, [...view], 0), true);
  assert.equal(canForkAt(persisted, [...view], 2), true);
  assert.equal(canForkAt(persisted, [...view], 1), false, 'an assistant message is not a fork point');
  assert.equal(canForkAt(persisted, [...view], 9), false, 'out of range');
  assert.equal(canForkAt(persisted, [...view], -1), false);
  assert.equal(canForkAt(persisted.slice(0, 2), [...view], 2), false, 'the view is longer than what is saved');
  assert.equal(canForkAt([{ role: 'user', content: 'autre' }, ...persisted.slice(1)], [...view], 0), false, 'same index, different content');
});

test('canForkAt reads legacy roles: a persisted "human" message is the user message the view shows', () => {
  assert.equal(canForkAt([{ role: 'human', content: 'salut' }], [{ role: 'user', content: 'salut' }], 0), true);
});

test('a fresh chat is on main with no branches', () => {
  assert.equal(initialChatState.currentBranchId, 'main');
  assert.deepEqual(initialChatState.branches, []);
  assert.equal(initialChatState.notice, null);
});

test('branches-loaded stores the list; folder-loaded forgets the previous folder’s branches', () => {
  const loaded = chatReducer(initialChatState, { type: 'branches-loaded', branches: [MAIN, fork('a', 'Branche 1')] });
  assert.equal(loaded.branches.length, 2);
  const switched = chatReducer({ ...loaded, currentBranchId: 'a' }, { type: 'folder-loaded', messages: [] });
  assert.deepEqual(switched.branches, []);
  assert.equal(switched.currentBranchId, 'main', 'a new folder always opens on main');
});

test('branch-created switches to the new branch, shows its view and announces it', () => {
  const start: ChatState = { ...initialChatState, messages: [...view], branches: [MAIN] };
  const next = chatReducer(start, {
    type: 'branch-created', id: 'a', label: 'Branche 1', branches: [MAIN, fork('a', 'Branche 1')], messages: [{ role: 'user', content: 'premier' }],
  });
  assert.equal(next.currentBranchId, 'a');
  assert.deepEqual(next.messages.map(m => m.content), ['premier']);
  assert.equal(next.branches.length, 2);
  assert.equal(next.notice, "Branche 'Branche 1' créée.");
});

test('branch-switched replaces the view and clears what belonged to the previous one, without a notice', () => {
  const start: ChatState = {
    ...initialChatState, messages: [...view], branches: [MAIN, fork('a', 'Branche 1')], currentBranchId: 'main',
    error: 'ancienne erreur', notice: 'ancien avis', streamingText: 'x',
  };
  const next = chatReducer(start, { type: 'branch-switched', id: 'a', messages: [{ role: 'user', content: 'premier' }] });
  assert.equal(next.currentBranchId, 'a');
  assert.deepEqual(next.messages.map(m => m.content), ['premier']);
  assert.equal(next.error, null);
  assert.equal(next.notice, null, 'switching announces nothing');
  assert.equal(next.streamingText, '');
  assert.deepEqual(next.branches, start.branches, 'switching never changes the list');
});

test('fork and switch are ignored while the agent runs (a stale answer must not swap the view under a run)', () => {
  const start = running({ ...initialChatState, messages: [...view], branches: [MAIN] });
  assert.equal(chatReducer(start, { type: 'branch-switched', id: 'a', messages: [] }), start);
  assert.equal(
    chatReducer(start, { type: 'branch-created', id: 'a', label: 'Branche 1', branches: [MAIN, fork('a', 'Branche 1')], messages: [] }),
    start,
  );
});

test('sending keeps the current branch; the reply lands in the same view', () => {
  const onFork: ChatState = { ...initialChatState, currentBranchId: 'a', branches: [MAIN, fork('a', 'Branche 1')] };
  const sent = chatReducer(onFork, { type: 'send-started', runId: 'run-1', text: 'suite' });
  assert.equal(sent.currentBranchId, 'a');
  assert.deepEqual(sent.branches, onFork.branches);
});

test('clear-notice and branch-failed', () => {
  const noticed = chatReducer(initialChatState, { type: 'branch-created', id: 'a', label: 'B', branches: [MAIN], messages: [] });
  assert.equal(chatReducer(noticed, { type: 'clear-notice' }).notice, null);
  assert.equal(chatReducer(initialChatState, { type: 'branch-failed', error: 'boom' }).error, 'boom');
});
