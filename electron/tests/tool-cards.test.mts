import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DETAIL_MAX, diffLineKinds, toolDetail, withToolCards } from '../renderer-src/src/state/tool-cards.ts';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (value: Record<string, unknown>) => JSON.stringify(value);
const agentEvent = (body: Record<string, unknown>) => ({ type: 'agent-event' as const, event: { type: 'event', event: 'agent', runId: 'r1', ...body } as never });

test('toolDetail: path for the file tools, command for run_command, query or url for search and the web, nothing for the others; cut to 120 characters', () => {
  assert.equal(TOOL_DETAIL_MAX, 120);
  for (const tool of ['read_file', 'view_file', 'list_dir', 'create_file', 'edit_file', 'create_dir', 'delete_file', 'delete_dir', 'grep_file', 'glob_files', 'grep_codebase']) {
    assert.equal(toolDetail(tool, json({ path: 'src/app.ts', pattern: '*.ts' })), 'src/app.ts', tool);
  }
  assert.equal(toolDetail('run_command', json({ command: 'npm test', timeout: 5 })), 'npm test');
  for (const tool of ['internet_search', 'semantic_search', 'knowledge_search']) assert.equal(toolDetail(tool, json({ query: 'tri rapide' })), 'tri rapide', tool);
  assert.equal(toolDetail('fetch_url', json({ url: 'https://example.com/page' })), 'https://example.com/page');
  assert.equal(toolDetail('git_blame', json({ file: 'a.ts', path: 'a.ts' })), undefined, 'not a file, shell, search or web tool');
  assert.equal(toolDetail('save_memory', json({ query: 'x' })), undefined);
  assert.equal(toolDetail('glob_files', json({ pattern: '*.ts' })), undefined, 'no path given: no detail');
  assert.equal(toolDetail('read_file', 'pas du JSON'), undefined);
  assert.equal(toolDetail('read_file', json({ path: '   ' })), undefined);
  assert.equal(toolDetail(undefined, json({ path: 'a' })), undefined);
  const long = 'x'.repeat(300);
  assert.equal(toolDetail('run_command', json({ command: long })), long.slice(0, 120));
});

test('withToolCards: a saved result shows its saved name and category; an older one gets its name from the preceding call and no category (neutral badge); both get their detail', () => {
  const messages: any[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'create_file', { path: 'notes.md', content: 'x' }), call('c2', 'read_file', { path: 'old.txt' })] },
    { role: 'tool', tool_call_id: 'c1', name: 'create_file', category: 'write', content: 'Créé : notes.md' },
    { role: 'tool', tool_call_id: 'c2', content: 'ancien contenu' },
    { role: 'tool', tool_call_id: 'nowhere', content: 'orphelin' },
    { role: 'assistant', content: 'fin' },
  ];
  const cards = withToolCards(messages);
  assert.equal(cards[0], messages[0], 'a message that is not a tool result is passed through as is');
  assert.equal(cards[1], messages[1]);
  assert.equal(cards[5], messages[5]);
  assert.deepEqual(cards[2], { ...messages[2], _tool: 'create_file', _category: 'write', _detail: 'notes.md' });
  assert.deepEqual(cards[3], { ...messages[3], _tool: 'read_file', _detail: 'old.txt' }, 'name recovered from the call, no category');
  assert.deepEqual(cards[4], { ...messages[4] }, 'a result whose call is unknown gets nothing invented');
});

test('the reducer builds the cards on every load and live: folder, branch switch and creation, compaction, tool-start and the result', () => {
  const history: any[] = [
    { role: 'user', content: 'liste' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'list_dir', { path: 'src' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
  ];
  const expected = { _tool: 'list_dir', _detail: 'src' };
  const pick = (state: ChatState) => ({ _tool: state.messages[2]._tool, _detail: state.messages[2]._detail });
  const loaded = chatReducer(initialChatState, { type: 'folder-loaded', messages: history });
  assert.deepEqual(pick(loaded), expected, 'folder-loaded');
  assert.deepEqual(pick(chatReducer(loaded, { type: 'branch-switched', id: 'b', messages: history })), expected, 'branch-switched');
  assert.deepEqual(pick(chatReducer(loaded, { type: 'branch-created', id: 'b', label: 'Branche 1', branches: [], messages: history })), expected, 'branch-created');
  const compacting: ChatState = { ...loaded, compacting: true, compactionId: 'k1' };
  const compacted = chatReducer(compacting, { type: 'agent-event', event: { type: 'event', event: 'agent', runId: 'k1', kind: 'compacted', messages: history } as never });
  assert.deepEqual(pick(compacted), expected, 'compacted');

  let live = chatReducer(loaded, { type: 'send-started', runId: 'r1', text: 'teste' });
  live = chatReducer(live, agentEvent({ kind: 'message', message: { role: 'assistant', content: '', tool_calls: [call('c9', 'run_command', { command: 'npm test' })] } }));
  live = chatReducer(live, agentEvent({ kind: 'tool-start', id: 'c9', tool: 'run_command', category: 'shell' }));
  assert.deepEqual(live.liveToolStarts.c9, { tool: 'run_command', category: 'shell', detail: 'npm test' }, 'the pending card already shows its detail');
  live = chatReducer(live, agentEvent({ kind: 'message', message: { role: 'tool', tool_call_id: 'c9', name: 'run_command', category: 'shell', content: 'ok' } }));
  const card = live.messages.at(-1)!;
  assert.deepEqual([card._tool, card._category, card._detail], ['run_command', 'shell', 'npm test']);
  assert.deepEqual(live.liveToolStarts, {});
});

test('diffLineKinds: --- and +++ are file headers only as the first two lines of the diff; deeper, they are a removed and an added line', () => {
  const edit = ['Modifié : a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,3 @@', ' un', '--- x', '+++ x', ' trois'];
  assert.deepEqual(diffLineKinds(edit), ['context', 'header', 'header', 'hunk', 'context', 'removed', 'added', 'context']);
  // A result saved before the unified diff (`-old` / `+new`, no headers, no hunk): a line that happens to start
  // with --- or +++ is still the removal or the addition it is.
  assert.deepEqual(diffLineKinds(['Modifié : a.txt', '--- x', '+++ y']), ['context', 'removed', 'added']);
});
