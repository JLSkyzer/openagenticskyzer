import { test } from 'node:test';
import assert from 'node:assert/strict';

const { requestMessages, fitToBudget, closeDanglingCalls, estimateRequestTokens, CONTEXT_FULL } = await import('../core/request-context.mts');
const { CONTEXT_WINDOWS, contextWindow, contextBudget, characters, tokensFor } = await import('../core/context-budget.mts');

const TEXT = { name: 'notes.txt', content_type: 'text', content: 'FICHIER-SECRET-42', size_kb: 1 };
const callMessage = (id: string, name: string, args: string, content = '') => ({ role: 'assistant' as const, content, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: args } }] });
const result = (id: string, content: string) => ({ role: 'tool' as const, tool_call_id: id, content });

test('earlier turns send only user messages and assistant TEXT; the turn in progress is sent whole', () => {
  const stored: any[] = [
    { role: 'user', content: 'lis', attachments: [TEXT] },
    callMessage('c1', 'read_file', '{"path":"a"}', 'Je lis.'),
    result('c1', 'contenu lu'),
    callMessage('c2', 'list_dir', '{}'),
    result('c2', 'a\nb'),
    { role: 'assistant', content: 'Voilà.' },
    { role: 'user', content: 'et maintenant ?', attachments: [TEXT] },
    callMessage('c3', 'read_file', '{"path":"b"}'),
    result('c3', 'contenu b'),
  ];
  const before = structuredClone(stored);
  assert.deepEqual(requestMessages(stored), [
    { role: 'user', content: '[pièce jointe : notes.txt]\nlis' },
    { role: 'assistant', content: 'Je lis.' },
    { role: 'assistant', content: 'Voilà.' },
    { role: 'user', content: '--- notes.txt ---\nFICHIER-SECRET-42\n---\n\net maintenant ?' },
    callMessage('c3', 'read_file', '{"path":"b"}'),
    result('c3', 'contenu b'),
  ]);
  assert.deepEqual(stored, before, 'the stored conversation is never modified');
  assert.deepEqual(requestMessages([callMessage('x', 'read', '{}'), result('x', 'r')] as any), [callMessage('x', 'read', '{}'), result('x', 'r')], 'no user message: everything is the current turn');
});

test('the estimate counts the system prompt, the tool schemas, texts, call arguments and results', () => {
  const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'd', parameters: {} } }];
  const messages: any[] = [{ role: 'user', content: 'x'.repeat(40) }, callMessage('c', 'read_file', 'y'.repeat(36)), result('c', 'z'.repeat(80))];
  const expected = tokensFor(8 + JSON.stringify(tools).length + 40 + 'read_file'.length + 36 + 80);
  assert.equal(estimateRequestTokens('s'.repeat(8), tools, messages), expected);
});

test('over budget, the OLDEST tool results of the turn in progress are replaced first, one by one', () => {
  const messages: any[] = [
    { role: 'user', content: 'avant' }, { role: 'assistant', content: 'r'.repeat(400) },
    { role: 'user', content: 'maintenant' },
    callMessage('c1', 'read_file', '{}'), result('c1', 'a'.repeat(1000)),
    callMessage('c2', 'grep_codebase', '{}'), result('c2', 'b'.repeat(1000)),
  ];
  const full = estimateRequestTokens('', [], messages);
  const fitted = fitToBudget(messages, { system: '', tools: [], budgetTokens: full - 100 });
  assert.equal(fitted[4].content, '[sortie de read_file retirée pour tenir dans le contexte : 1000 caractères]');
  assert.equal(fitted[6].content, 'b'.repeat(1000), 'the newest result is kept while the budget allows');
  assert.equal(fitted[1].content, 'r'.repeat(400), 'an earlier turn is never cut here');
  assert.equal(messages[4].content, 'a'.repeat(1000), 'the input array is not modified');
  assert.deepEqual(fitToBudget(messages, { system: '', tools: [], budgetTokens: full }), messages, 'within budget: unchanged');
});

test('when the history alone exceeds the budget, nothing is sent: "Contexte plein"', () => {
  const messages: any[] = [{ role: 'user', content: 'x'.repeat(4000) }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'suite' }];
  assert.equal(CONTEXT_FULL, 'Contexte plein : compacte ou efface la conversation');
  assert.throws(() => fitToBudget(messages, { system: '', tools: [], budgetTokens: 500 }), { message: CONTEXT_FULL });
  assert.throws(() => fitToBudget([{ role: 'user', content: 'q' }], { system: 'p'.repeat(4000), tools: [], budgetTokens: 500 }), { message: CONTEXT_FULL }, 'the system prompt counts too');
});

test('a tool call left without its result gets one, in call order; a complete transcript is untouched', () => {
  const messages: any[] = [
    { role: 'user', content: 'go' },
    { ...callMessage('c1', 'read_file', '{}'), tool_calls: [callMessage('c1', 'read_file', '{}').tool_calls[0], callMessage('c2', 'run_command', '{}').tool_calls[0]] },
    result('c1', 'lu'),
  ];
  const { messages: repaired, added } = closeDanglingCalls(messages, "Interrompu par l'utilisateur");
  assert.deepEqual(added, [{ role: 'tool', tool_call_id: 'c2', content: "Interrompu par l'utilisateur" }]);
  assert.deepEqual(repaired.map(m => [m.role, m.tool_call_id ?? null]), [['user', null], ['assistant', null], ['tool', 'c1'], ['tool', 'c2']]);
  const complete: any[] = [{ role: 'user', content: 'go' }, callMessage('c1', 'read_file', '{}'), result('c1', 'lu'), { role: 'assistant', content: 'fin' }];
  assert.deepEqual(closeDanglingCalls(complete, 'x'), { messages: complete, added: [] });
  assert.equal(closeDanglingCalls([{ role: 'user', content: 'go' }, callMessage('c9', 'git_commit', '{}')] as any, 'Interrompu : boom').added[0].content, 'Interrompu : boom');
});

test('the shared window table and the 4-characters estimate', () => {
  assert.deepEqual({ ...CONTEXT_WINDOWS }, { together: 128_000, groq: 128_000, mistral: 32_000, gemini: 1_000_000, openrouter: 128_000, ollama: 32_000, lmstudio: 32_000, llamacpp: 32_000 });
  assert.equal(contextWindow('groq', null), 128_000);
  assert.equal(contextWindow('groq', 20_000), 20_000, 'max_tokens wins');
  assert.equal(contextWindow(null, null), 32_000);
  assert.equal(contextWindow('constructor', null), 32_000, 'never an inherited property');
  assert.equal(contextBudget(32_000, 2048), 29_952);
  assert.equal(contextBudget(100, 5000), 1);
  assert.equal(characters('😀😀'), 2);
  assert.equal(tokensFor(7), 1);
});
