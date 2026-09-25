import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';
import { lastAssistantIndex, lastUserIndex } from '../renderer-src/src/state/editing.ts';

const history = [
  { role: 'user', content: 'premier' },
  { role: 'assistant', content: 'réponse 1' },
  { role: 'user', content: 'second' },
  { role: 'assistant', content: '' }, // tool-only turn: nothing on screen
  { role: 'tool', content: 'a.py' },
  { role: 'assistant', content: 'réponse 2' },
] as const;
const loaded = (): ChatState => chatReducer(initialChatState, { type: 'folder-loaded', messages: [...history] });

test('lastUserIndex finds the last user message, legacy "human" included; -1 when there is none', () => {
  assert.equal(lastUserIndex([...history]), 2);
  assert.equal(lastUserIndex([{ role: 'human', content: 'salut' }, { role: 'ai', content: 'hey' }]), 0);
  assert.equal(lastUserIndex([{ role: 'assistant', content: 'seul' }]), -1);
  assert.equal(lastUserIndex([]), -1);
});

test('lastAssistantIndex is the last assistant message that has text (a tool-only turn shows no bubble)', () => {
  assert.equal(lastAssistantIndex([...history]), 5);
  assert.equal(lastAssistantIndex([...history.slice(0, 4)]), 1, 'the empty tool-only turn is not the one to regenerate');
  assert.equal(lastAssistantIndex([{ role: 'user', content: 'x' }]), -1);
});

test('send-started with `keep` cuts the view there before adding the new message (regenerate)', () => {
  const next = chatReducer(loaded(), { type: 'send-started', runId: 'r1', text: 'second', keep: 2 });
  assert.deepEqual(next.messages, [{ role: 'user', content: 'premier' }, { role: 'assistant', content: 'réponse 1' }, { role: 'user', content: 'second' }]);
  assert.equal(next.agentRunning, true);
  assert.equal(next.truncatedTo, null, 'the pending cut is consumed by the send');
});

test('send-started without `keep` keeps everything, exactly as before', () => {
  const next = chatReducer(loaded(), { type: 'send-started', runId: 'r1', text: 'suite' });
  assert.equal(next.messages.length, history.length + 1);
});

test('messages-truncated (edit) cuts the view and remembers the cut, so the next send can apply it on disk', () => {
  const next = chatReducer(loaded(), { type: 'messages-truncated', keep: 2 });
  assert.equal(next.messages.length, 2);
  assert.equal(next.truncatedTo, 2);
  assert.equal(next.error, null);
});

test('a pending cut is forgotten on any view swap: folder, branch switch, fork, and after a compaction starts', () => {
  const cut = chatReducer(loaded(), { type: 'messages-truncated', keep: 2 });
  assert.equal(chatReducer(cut, { type: 'folder-loaded', messages: [] }).truncatedTo, null);
  assert.equal(chatReducer(cut, { type: 'branch-switched', id: 'main', messages: [...history] }).truncatedTo, null);
  assert.equal(chatReducer(cut, { type: 'branch-created', id: 'b', label: 'Branche 1', branches: [], messages: [] }).truncatedTo, null);
  assert.equal(chatReducer(cut, { type: 'compaction-started', id: 'c1' }).truncatedTo, null);
});

test('messages-truncated is ignored while a run is in flight or a summary is being made', () => {
  const running = { ...loaded(), agentRunning: true };
  assert.equal(chatReducer(running, { type: 'messages-truncated', keep: 2 }), running);
  const compacting = { ...loaded(), compacting: true };
  assert.equal(chatReducer(compacting, { type: 'messages-truncated', keep: 2 }), compacting);
});
