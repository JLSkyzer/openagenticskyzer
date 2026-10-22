import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestProvider } from './support/test-model-provider.mts';

const sse = (events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('');

/** A real OpenAI-compatible server on 127.0.0.1, driven through the test seam's client: request N (from 0) is
 * answered, as JSON, with answer(N). `bodies` holds every request as the server received it. */
async function scriptedModel(t: { after(fn: () => unknown): void }, answer: (index: number) => unknown) {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer(bodies.length - 1)));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  return { bodies, provider: createTestProvider({ base_url: `http://127.0.0.1:${port}/v1` }) };
}

test('agent reinjects actual tool results and never executes a write in plan or strict mode', async t => {
  const { runAgent } = await import('../core/agent.mts');
  for (const setting of [{ mode: 'plan', permission_mode: 'auto' }, { mode: 'auto', permission_mode: 'strict' }, { mode: 'ask', permission_mode: 'auto' }]) {
    let effects = 0;
    const { bodies: requests, provider } = await scriptedModel(t, index => ({ choices: [{ message: index === 0 ? {
      content: '', tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: '{"text":"no"}' } }],
    } : { content: 'Terminé' }, finish_reason: index === 0 ? 'tool_calls' : 'stop' }] }));
    const result = await runAgent({ provider, messages: [{ role: 'user', content: 'write' }], instructions: 'Instructions projet sentinelle',
      tools: [{ name: 'write_file', description: 'Write', category: 'write', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, validate: () => {}, execute: async () => { effects++; return 'written'; } }],
      settings: setting as any, confirm: async () => true,
    });
    assert.equal(effects, 0);
    assert.match(requests[1].messages.find((m: any) => m.role === 'tool').content, /refus/i);
    assert.equal(requests[0].messages[0].content, 'Instructions projet sentinelle');
    assert.equal(result.at(-1)?.content, 'Terminé');
  }
});

test('approved tool executes once with validated arguments and its result reaches the provider', async t => {
  const { runAgent } = await import('../core/agent.mts');
  const effects: string[] = [];
  let release!: (value: boolean) => void;
  const decision = new Promise<boolean>(resolve => { release = resolve; });
  let permissionRequested!: () => void;
  const requested = new Promise<void>(resolve => { permissionRequested = resolve; });
  const { bodies: requests, provider } = await scriptedModel(t, index => ({ choices: [{ message: index === 0 ? {
    content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'write_file', arguments: '{"text":"hello"}' } }],
  } : { content: 'done' }, finish_reason: index === 0 ? 'tool_calls' : 'stop' }] }));
  const running = runAgent({ provider, messages: [{ role: 'user', content: 'write' }], instructions: '',
    tools: [{ name: 'write_file', description: '', category: 'write', parameters: { type: 'object' }, validate: args => { assert.equal(args.text, 'hello'); }, execute: async args => { effects.push(args.text as string); return 'created hello'; } }],
    settings: { mode: 'auto', permission_mode: 'demander', files_ask: true },
    confirm: async () => { permissionRequested(); return decision; },
  });
  await requested;
  assert.deepEqual(effects, []);
  release(true); await running;
  assert.deepEqual(effects, ['hello']);
  assert.equal(requests[1].messages.at(-1).content, 'created hello');
});

test('cancellation while waiting for approval exits without executing the tool', async t => {
  const { runAgent } = await import('../core/agent.mts');
  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController(); let effects = 0;
  const { provider } = await scriptedModel(t, () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
  const task = runAgent({ provider, messages: [], instructions: '', signal: controller.signal,
    tools: [{ name: 'shell', description: '', parameters: { type: 'object' }, category: 'shell', validate: () => {}, execute: async () => { effects++; return ''; } }],
    settings: { mode: 'auto', permission_mode: 'demander', shell_ask: true },
    confirm: async () => { started(); return new Promise(() => {}); },
  });
  await waiting; controller.abort();
  await assert.rejects(task, (e: any) => e.name === 'AbortError');
  assert.equal(effects, 0);
});

test('shell_ask decides whether a shell tool asks; it never widens plan/strict or other categories', async t => {
  const { runAgent } = await import('../core/agent.mts');
  const cases: Array<{ name: string; category: 'shell' | 'extension'; settings: any; approve: boolean; expectAsk: boolean; expectRun: boolean }> = [
    { name: 'shell_ask=false runs without asking', category: 'shell', settings: { mode: 'auto', permission_mode: 'demander', shell_ask: false }, approve: true, expectAsk: false, expectRun: true },
    { name: 'shell_ask=true asks (approved)', category: 'shell', settings: { mode: 'auto', permission_mode: 'demander', shell_ask: true }, approve: true, expectAsk: true, expectRun: true },
    { name: 'shell_ask=true asks (refused)', category: 'shell', settings: { mode: 'auto', permission_mode: 'demander', shell_ask: true }, approve: false, expectAsk: true, expectRun: false },
    { name: 'unset shell_ask asks by default', category: 'shell', settings: { mode: 'auto', permission_mode: 'demander' }, approve: false, expectAsk: true, expectRun: false },
    { name: 'plan mode still denies', category: 'shell', settings: { mode: 'plan', permission_mode: 'demander', shell_ask: false }, approve: true, expectAsk: false, expectRun: false },
    { name: 'ask mode still denies', category: 'shell', settings: { mode: 'ask', permission_mode: 'demander', shell_ask: false }, approve: true, expectAsk: false, expectRun: false },
    { name: 'strict still denies', category: 'shell', settings: { mode: 'auto', permission_mode: 'strict', shell_ask: false }, approve: true, expectAsk: false, expectRun: false },
    { name: 'shell_ask=false does not unlock extensions', category: 'extension', settings: { mode: 'auto', permission_mode: 'demander', shell_ask: false }, approve: false, expectAsk: true, expectRun: false },
  ];
  for (const c of cases) {
    let asked = 0; let ran = 0;
    const { provider } = await scriptedModel(t, index => ({ choices: [{ message: index === 0
      ? { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'run', arguments: '{}' } }] } : { content: 'ok' }, finish_reason: index === 0 ? 'tool_calls' : 'stop' }] }));
    await runAgent({ provider, instructions: '', messages: [], settings: c.settings,
      tools: [{ name: 'run', description: '', category: c.category, parameters: { type: 'object' }, validate: () => {}, execute: async () => { ran++; return 'done'; } }],
      confirm: async () => { asked++; return c.approve; },
    });
    assert.equal(asked > 0, c.expectAsk, `${c.name}: asked`);
    assert.equal(ran > 0, c.expectRun, `${c.name}: ran`);
  }
});

test('agent refuses invalid arguments, duplicate call IDs and bounds repeated tool requests', async t => {
  const { runAgent } = await import('../core/agent.mts');
  let effects = 0;
  const { bodies, provider } = await scriptedModel(t, index => {
    const requests = index + 1;
    const id = requests <= 2 ? 'same-id' : `call-${requests}`;
    return { choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: requests === 1 ? 'not JSON' : '{}' } }] }, finish_reason: 'tool_calls' }] };
  });
  await assert.rejects(runAgent({ provider, instructions: '', messages: [], maxSteps: 8,
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    tools: [{ name: 'read', category: 'read', description: '', parameters: {}, validate: () => {}, execute: async () => { effects++; return 'result'; } }],
  }), /Limite de tours/);
  assert.equal(bodies.length, 8);
  assert.equal(effects, 3);
});

test('the repeat guard counts consecutive identical calls, so checking state between edits is allowed', async t => {
  const { runAgent } = await import('../core/agent.mts');
  const script = ['check', 'edit', 'check', 'edit', 'check', 'edit', 'check', 'edit', 'check'];
  const ran: string[] = [];
  const { provider } = await scriptedModel(t, index => {
    const name = script[index];
    return { choices: [{ message: name ? { content: '', tool_calls: [{ id: `call-${index + 1}`, type: 'function', function: { name, arguments: '{}' } }] } : { content: 'fin' }, finish_reason: name ? 'tool_calls' : 'stop' }] };
  });
  const tool = (name: string) => ({ name, category: 'read' as const, description: '', parameters: {}, validate: () => {}, execute: async () => { ran.push(name); return 'ok'; } });
  await runAgent({ provider, instructions: '', messages: [], maxSteps: 12, settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true, tools: [tool('check'), tool('edit')] });
  assert.deepEqual(ran, script.filter(Boolean), 'the same check before and after each edit is legitimate, not a loop');
});

// Seam evidence (ruling F11): the test client cannot be redirected off the loopback server it was given.
test('real HTTP transport refuses redirects and cancellation closes a streaming request', async t => {
  let redirectReached = false;
  let streaming!: () => void;
  const started = new Promise<void>(resolve => { streaming = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/redirect/chat/completions') { response.writeHead(307, { location: '/stolen' }); response.end(); }
    else if (request.url === '/stolen') { redirectReached = true; response.end(); }
    else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse([{ choices: [{ delta: { content: 'En cours' } }] }]));
      response.on('close', closed); streaming();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(createTestProvider({ base_url: `http://127.0.0.1:${port}/redirect` }).complete({ messages: [] }));
  assert.equal(redirectReached, false);
  const controller = new AbortController();
  const task = createTestProvider({ base_url: `http://127.0.0.1:${port}/v1` }).complete({ messages: [], signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(task, (e: any) => e.name === 'AbortError');
  await disconnected;
});

test('a tool result is saved with its tool name and category, and neither field is ever sent to the provider', async t => {
  const { runAgent } = await import('../core/agent.mts');
  const calls = [
    { id: 'k', type: 'function', function: { name: 'look', arguments: '{}' } },
    { id: 'u', type: 'function', function: { name: 'ghost', arguments: '{}' } },
  ];
  const { bodies: requests, provider } = await scriptedModel(t, index => ({ choices: [{ message: index === 0 ? { content: '', tool_calls: calls } : { content: 'fin' }, finish_reason: index === 0 ? 'tool_calls' : 'stop' }] }));
  const result = await runAgent({ provider, instructions: '', messages: [{ role: 'user', content: 'go' }],
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    tools: [{ name: 'look', description: '', category: 'read', parameters: { type: 'object' }, validate: () => {}, execute: async () => 'vu' }],
  });
  const saved = result.filter(m => m.role === 'tool');
  assert.deepEqual(saved.map(m => [m.tool_call_id, m.name, m.category, m.content]), [
    ['k', 'look', 'read', 'vu'],
    ['u', 'ghost', undefined, 'Erreur : Outil inconnu : exécution refusée'],
  ]);
  assert.equal('category' in saved[1], false, 'an unknown tool has no category, never a guessed one');
  const sent = requests[1].messages.filter((m: any) => m.role === 'tool');
  assert.equal(sent.length, 2);
  for (const message of sent) assert.deepEqual(Object.keys(message).sort(), ['content', 'role', 'tool_call_id']);
});

test('runAgent forwards the provider\'s reasoning and stats as thinking and stats events, and keeps reasoning on the reply', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const provider = {
    complete: async (options: any) => {
      options.onReasoning({ text: 'pensée' });
      options.onReasoning({ text: 'avant', moved: true });
      options.onDelta('réponse');
      options.onStats({ inputTokens: 3, outputTokens: 2, generationMs: 5 });
      return { role: 'assistant' as const, content: 'réponse', reasoning: 'avantpensée', reasoningMs: 7 };
    },
    contextWindow: async () => 16384,
    outputCap: () => undefined,
  };
  const result = await runAgent({ provider, messages: [{ role: 'user', content: 'q' }], instructions: 'i', tools: [],
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true, emit: event => events.push(event) });
  assert.deepEqual(events.filter(e => e.type !== 'turn').map(e => e.type), ['thinking', 'thinking', 'delta', 'stats', 'message']);
  assert.deepEqual(events.filter(e => e.type === 'thinking'), [{ type: 'thinking', text: 'pensée' }, { type: 'thinking', text: 'avant', moved: true }]);
  assert.deepEqual(events.find(e => e.type === 'stats'), { type: 'stats', inputTokens: 3, outputTokens: 2, generationMs: 5 });
  assert.equal(result[1].reasoning, 'avantpensée');
  assert.equal(result[1].reasoningMs, 7);
});
