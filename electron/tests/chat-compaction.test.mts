import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';

const MAIN = { id: 'main', label: 'Principale', created_at: '2026-09-21T10:00:00.000Z', message_count: 4 };
const view = [
  { role: 'user', content: 'premier' }, { role: 'assistant', content: 'réponse 1' },
  { role: 'user', content: 'second' }, { role: 'assistant', content: 'réponse 2' },
] as const;
const summary = { role: 'assistant', content: '**[Résumé de contexte compressé]**\n\n- point' } as const;

const compacting = (state: ChatState = initialChatState): ChatState => chatReducer(state, { type: 'compaction-started', id: 'c1' });
const event = (kind: string, extra: object) => ({ type: 'agent-event' as const, event: { type: 'event', event: 'agent', runId: 'c1', kind, ...extra } as any });

test('a fresh chat is not compacting', () => {
  assert.equal(initialChatState.compacting, false);
  assert.equal(initialChatState.compactionId, null);
});

test('compaction-started marks the chat as compacting and remembers which compaction to wait for', () => {
  const next = compacting();
  assert.equal(next.compacting, true);
  assert.equal(next.compactionId, 'c1');
  assert.equal(next.error, null);
});

test('compacted replaces the messages on screen, ends the compaction and announces it', () => {
  const start = compacting({ ...initialChatState, messages: [...view], error: 'ancienne erreur' });
  const next = chatReducer(start, event('compacted', { messages: [summary, view[2], view[3]] }));
  assert.deepEqual(next.messages.map(m => m.content), [summary.content, 'second', 'réponse 2']);
  assert.equal(next.compacting, false);
  assert.equal(next.compactionId, null);
  assert.equal(next.notice, 'Contexte compressé avec résumé IA.');
  assert.equal(next.error, null);
});

test('compact-failed keeps every message and shows the reason', () => {
  const start = compacting({ ...initialChatState, messages: [...view] });
  const next = chatReducer(start, event('compact-failed', { message: 'Erreur du provider (500).' }));
  assert.deepEqual(next.messages, start.messages, 'nothing was dropped');
  assert.equal(next.error, 'Erreur du provider (500).');
  assert.equal(next.compacting, false);
  assert.equal(next.compactionId, null);
});

test('the end of a compaction we no longer wait for is ignored (another folder, another compaction)', () => {
  const start = compacting({ ...initialChatState, messages: [...view] });
  const stale = { type: 'agent-event' as const, event: { type: 'event', event: 'agent', runId: 'autre', kind: 'compacted', messages: [summary] } as any };
  assert.equal(chatReducer(start, stale), start);
  const idle = chatReducer(initialChatState, event('compacted', { messages: [summary] }));
  assert.equal(idle, initialChatState, 'nothing was requested, nothing changes');
});

test('switching folder forgets a compaction that was in flight', () => {
  const next = chatReducer(compacting(), { type: 'folder-loaded', messages: [] });
  assert.equal(next.compacting, false);
  assert.equal(next.compactionId, null);
});

test('branch operations are ignored while a compaction is running (it rewrites the branch on screen)', () => {
  const start = compacting({ ...initialChatState, messages: [...view], branches: [MAIN] });
  assert.equal(chatReducer(start, { type: 'branch-switched', id: 'a', messages: [] }), start);
  assert.equal(
    chatReducer(start, { type: 'branch-created', id: 'a', label: 'Branche 1', branches: [MAIN], messages: [] }),
    start,
  );
});

test('show-error displays a refusal (e.g. "Pas assez de messages à compresser.") without touching the messages', () => {
  const start: ChatState = { ...initialChatState, messages: [...view] };
  const next = chatReducer(start, { type: 'show-error', error: 'Pas assez de messages à compresser.' });
  assert.equal(next.error, 'Pas assez de messages à compresser.');
  assert.deepEqual(next.messages, start.messages);
  assert.equal(next.compacting, false, 'a refused request never starts a compaction');
});

test('a compaction does not disturb an agent run identifier', () => {
  const running = chatReducer(initialChatState, { type: 'send-started', runId: 'run-1', text: 'salut' });
  const next = chatReducer(running, { type: 'compaction-started', id: 'c1' });
  assert.equal(next.runId, 'run-1');
});
