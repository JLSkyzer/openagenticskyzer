import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSchema, historyFromMessages, responseToMessage, toGgufFunctions } from '../core/local-provider.mts';

// core/local-provider.mts is PURE — it never imports node-llama-cpp itself (that native binding lives in
// local-engine.mts, loaded on first actual use). Every test here runs against plain fixtures shaped like
// node-llama-cpp's own types (ChatHistoryItem, LlamaChatResponse), never the real engine.

test('toGgufFunctions maps our OpenAI-shaped tool schemas to node-llama-cpp\'s {name: {description, params}} — no handler at this level: WE execute, it only asks', () => {
  const tools = [
    { type: 'function' as const, function: { name: 'read_file', description: 'Lit un fichier', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ];
  assert.deepEqual(toGgufFunctions(tools), { read_file: { description: 'Lit un fichier', params: { type: 'object', properties: { path: { type: 'string' } } } } });
  assert.equal(toGgufFunctions([]), undefined, 'no tools at all: undefined, not an empty object (node-llama-cpp treats {} as "functions enabled, none defined")');
});

test('compactSchema drops $schema, title, examples and an empty required, and keeps types, enums, required, additionalProperties and descriptions', () => {
  // An MCP-like schema: noise at every level, a parameter NAMED title, data that looks like noise.
  const mcp = {
    $schema: 'http://json-schema.org/draft-07/schema#', title: 'create_issue', $comment: 'generated', type: 'object', additionalProperties: false,
    required: ['title', 'labels'],
    properties: {
      title: { type: 'string', title: 'Titre', description: 'Titre du ticket', maxLength: 200, examples: ['Bug'] },
      labels: { type: 'array', items: { type: 'string', enum: ['bug', 'title'], title: 'Label' }, minItems: 1 },
      meta: { type: 'object', required: [], properties: { draft: { type: 'boolean', default: { title: 'kept: data' } } }, additionalProperties: true },
      kind: { const: { title: 'x' } },
    },
  };
  assert.deepEqual(compactSchema(mcp), {
    type: 'object', additionalProperties: false, required: ['title', 'labels'],
    properties: {
      title: { type: 'string', description: 'Titre du ticket', maxLength: 200 },
      labels: { type: 'array', items: { type: 'string', enum: ['bug', 'title'] }, minItems: 1 },
      meta: { type: 'object', properties: { draft: { type: 'boolean', default: { title: 'kept: data' } } }, additionalProperties: true },
      kind: { const: { title: 'x' } },
    },
  });
  assert.equal(mcp.title, 'create_issue', 'the input is not edited');
  // A tool without parameters keeps an empty object schema node-llama-cpp accepts.
  assert.deepEqual(compactSchema({ type: 'object', properties: {}, required: [], additionalProperties: false }), { type: 'object', properties: {}, additionalProperties: false });
  // toGgufFunctions applies it only under the lever (shipped off: today's params, unchanged).
  const tools = [{ type: 'function' as const, function: { name: 'create_issue', description: 'Créer un ticket', parameters: mcp } }];
  assert.equal(toGgufFunctions(tools, false)?.create_issue.params, mcp);
  assert.deepEqual(toGgufFunctions(tools, true)?.create_issue.params, compactSchema(mcp));
});

test('compactSchema keeps the names in $defs, definitions and patternProperties (a definition named title survives) and compacts what they hold', () => {
  const schema = {
    type: 'object', title: 'root',
    $defs: { title: { type: 'string', title: 'noise', maxLength: 80 }, $comment: { type: 'integer', $comment: 'noise' } },
    definitions: { examples: { type: 'array', items: { $ref: '#/$defs/title' }, examples: [['x']] } },
    patternProperties: { '^title$': { type: 'boolean', title: 'noise' } },
    properties: { name: { $ref: '#/$defs/title' } },
  };
  assert.deepEqual(compactSchema(schema), {
    type: 'object',
    $defs: { title: { type: 'string', maxLength: 80 }, $comment: { type: 'integer' } },
    definitions: { examples: { type: 'array', items: { $ref: '#/$defs/title' } } },
    patternProperties: { '^title$': { type: 'boolean' } },
    properties: { name: { $ref: '#/$defs/title' } },
  });
});

test('historyFromMessages: system and user turns map straight across', () => {
  const history = historyFromMessages([
    { role: 'system', content: 'Tu es un agent.' },
    { role: 'user', content: 'Bonjour' },
  ]);
  assert.deepEqual(history, [
    { type: 'system', text: 'Tu es un agent.' },
    { type: 'user', text: 'Bonjour' },
  ]);
});

test('historyFromMessages: a plain assistant reply (no tool call) becomes a model turn with one text item', () => {
  const history = historyFromMessages([{ role: 'assistant', content: 'Salut !' }]);
  assert.deepEqual(history, [{ type: 'model', response: ['Salut !'] }]);
});

test('historyFromMessages: an assistant tool call is merged with its OWN result — the tool message never becomes its own history item', () => {
  const history = historyFromMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'contenu de a.txt' },
  ]);
  assert.deepEqual(history, [{
    type: 'model',
    response: [{ type: 'functionCall', name: 'read_file', params: { path: 'a.txt' }, result: 'contenu de a.txt' }],
  }]);
});

test('historyFromMessages: text AND a tool call in the same turn keep their order; several tool calls in one turn all get their own result', () => {
  const history = historyFromMessages([
    {
      role: 'assistant', content: 'Je vérifie deux fichiers.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'tool', tool_call_id: 'c2', content: 'B' },
  ]);
  assert.deepEqual(history, [{
    type: 'model',
    response: [
      'Je vérifie deux fichiers.',
      { type: 'functionCall', name: 'read_file', params: { path: 'a.txt' }, result: 'A' },
      { type: 'functionCall', name: 'read_file', params: { path: 'b.txt' }, result: 'B' },
    ],
  }]);
});

test('historyFromMessages: a tool call whose result has not arrived yet (mid-turn) gets no `result` key at all', () => {
  const history = historyFromMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  ]);
  assert.deepEqual(history, [{ type: 'model', response: [{ type: 'functionCall', name: 'read_file', params: {} }] }]);
});

test('historyFromMessages: a legacy "human"/"ai" role is read like user/assistant', () => {
  const history = historyFromMessages([{ role: 'human', content: 'salut' }, { role: 'ai', content: 'bonjour' }]);
  assert.deepEqual(history, [{ type: 'user', text: 'salut' }, { type: 'model', response: ['bonjour'] }]);
});

test('historyFromMessages: attached images are dropped with a clear note — a local GGUF text model cannot see them (documented limitation, never a crash)', () => {
  const history = historyFromMessages([{
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }, { type: 'text', text: 'décris' }],
  }]);
  assert.deepEqual(history, [{ type: 'user', text: '[1 image ignorée — non prise en charge par un modèle local]\n\ndécris' }]);
});

test('responseToMessage: plain text, no function calls — the shape a real ChatProvider returns for a normal reply', () => {
  const message = responseToMessage({ response: 'Bonjour !' }, () => 'unused');
  assert.deepEqual(message, { role: 'assistant', content: 'Bonjour !' });
  assert.equal('tool_calls' in message, false, 'no tool_calls key at all when there are none — same as the real provider');
});

test('responseToMessage: function calls become OpenAI-shaped tool_calls, arguments JSON-stringified, ids minted fresh', () => {
  let n = 0;
  const message = responseToMessage(
    { response: 'Je regarde.', functionCalls: [{ functionName: 'read_file', params: { path: 'a.txt' } }] },
    () => `local-${++n}`,
  );
  assert.deepEqual(message, {
    role: 'assistant', content: 'Je regarde.',
    tool_calls: [{ id: 'local-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  });
});

test('responseToMessage: several parallel function calls each get their own fresh id, in order', () => {
  let n = 0;
  const message = responseToMessage(
    { response: '', functionCalls: [{ functionName: 'a', params: {} }, { functionName: 'b', params: { x: 1 } }] },
    () => `local-${++n}`,
  );
  assert.deepEqual(message.tool_calls?.map(call => call.id), ['local-1', 'local-2']);
  assert.deepEqual(message.tool_calls?.map(call => call.function.name), ['a', 'b']);
});

test('a full round trip is stable: a real agent turn (assistant + tool_calls, then tool results) maps to history and back losslessly for what matters', () => {
  let n = 0;
  const first = responseToMessage({ response: '', functionCalls: [{ functionName: 'read_file', params: { path: 'a.txt' } }] }, () => `local-${++n}`);
  const messages = [
    { role: 'system' as const, content: 'instructions' },
    { role: 'user' as const, content: 'lis a.txt' },
    first,
    { role: 'tool' as const, tool_call_id: first.tool_calls![0].id, content: 'CONTENU-A' },
  ];
  const history = historyFromMessages(messages);
  assert.deepEqual(history[2], { type: 'model', response: [{ type: 'functionCall', name: 'read_file', params: { path: 'a.txt' }, result: 'CONTENU-A' }] });
});

test('responseToMessage flags a reply cut at maxTokens as truncated — the engine\'s own finish_reason "length"', () => {
  assert.deepEqual(responseToMessage({ response: 'abc', metadata: { stopReason: 'maxTokens' } }, () => 'x'), { role: 'assistant', content: 'abc', truncated: true });
  assert.equal('truncated' in responseToMessage({ response: 'abc', metadata: { stopReason: 'eogToken' } }, () => 'x'), false);
});
