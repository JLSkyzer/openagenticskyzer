import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const connection = { provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', model: 'test-model', api_key: 'fake-key' };
const sse = (events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join('');
function fragmented(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('provider decodes split UTF8/SSE and assembles tool arguments before exposing any call', async () => {
  const { ChatProvider } = await import('../core/provider.mts');
  const payloads: any[] = []; const deltas: string[] = [];
  const provider = new ChatProvider(async (url: any, options: any) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    payloads.push(JSON.parse(options.body));
    return fragmented(sse([
      { choices: [{ delta: { content: 'Déjà ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]));
  });
  const result = await provider.complete({ connection, messages: [{ role: 'user', content: 'read' }], onDelta: text => deltas.push(text) });
  assert.equal(result.content, 'Déjà ');
  assert.equal(deltas.join(''), 'Déjà ');
  assert.deepEqual(result.tool_calls, [{ id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]);
  assert.equal('tools' in payloads[0], false, 'Auxiliary/model-only calls must not expose any tools');
});

test('provider rejects incomplete streams and HTTP errors without echoing secrets', async () => {
  const { ChatProvider } = await import('../core/provider.mts');
  await assert.rejects(new ChatProvider(async () => fragmented(sse([{ choices: [{ delta: { content: 'partial' } }] }]))).complete({ connection, messages: [] }), /interrompu/i);
  const provider = new ChatProvider(async () => new Response('fake-key echo', { status: 429, headers: { 'retry-after': '3' } }));
  await assert.rejects(provider.complete({ connection, messages: [] }), (e: any) => {
    assert.equal(e.status, 429); assert.equal(e.retryAfter, 3);
    assert.equal(e.message.includes('fake-key'), false); return true;
  });
});

test('agent reinjects actual tool results and never executes a write in plan or strict mode', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  for (const setting of [{ mode: 'plan', permission_mode: 'auto' }, { mode: 'auto', permission_mode: 'strict' }, { mode: 'ask', permission_mode: 'auto' }]) {
    const requests: any[] = []; let effects = 0;
    const provider = new ChatProvider(async (_url: any, options: any) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? {
        content: '', tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: '{"text":"no"}' } }],
      } : { content: 'Terminé' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    });
    const result = await runAgent({ provider, connection, messages: [{ role: 'user', content: 'write' }], instructions: 'Instructions projet sentinelle',
      tools: [{ name: 'write_file', description: 'Write', category: 'write', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, validate: () => {}, execute: async () => { effects++; return 'written'; } }],
      settings: setting as any, confirm: async () => true,
    });
    assert.equal(effects, 0);
    assert.match(requests[1].messages.find((m: any) => m.role === 'tool').content, /refus/i);
    assert.equal(requests[0].messages[0].content, 'Instructions projet sentinelle');
    assert.equal(result.at(-1)?.content, 'Terminé');
  }
});

test('approved tool executes once with validated arguments and its result reaches the provider', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  const requests: any[] = []; const effects: string[] = [];
  let release!: (value: boolean) => void;
  const decision = new Promise<boolean>(resolve => { release = resolve; });
  let permissionRequested!: () => void;
  const requested = new Promise<void>(resolve => { permissionRequested = resolve; });
  const provider = new ChatProvider(async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? {
      content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'write_file', arguments: '{"text":"hello"}' } }],
    } : { content: 'done' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  const running = runAgent({ provider, connection, messages: [{ role: 'user', content: 'write' }], instructions: '',
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

test('cancellation while waiting for approval exits without executing the tool', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController(); let effects = 0;
  const provider = new ChatProvider(async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } }));
  const task = runAgent({ provider, connection, messages: [], instructions: '', signal: controller.signal,
    tools: [{ name: 'shell', description: '', parameters: { type: 'object' }, category: 'shell', validate: () => {}, execute: async () => { effects++; return ''; } }],
    settings: { mode: 'auto', permission_mode: 'demander', shell_ask: true },
    confirm: async () => { started(); return new Promise(() => {}); },
  });
  await waiting; controller.abort();
  await assert.rejects(task, (e: any) => e.name === 'AbortError');
  assert.equal(effects, 0);
});

test('agent refuses invalid arguments, duplicate call IDs and bounds repeated tool requests', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  let requests = 0; let effects = 0;
  const provider = new ChatProvider(async () => {
    requests++;
    const id = requests <= 2 ? 'same-id' : `call-${requests}`;
    return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: requests === 1 ? 'not JSON' : '{}' } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(runAgent({ provider, connection, instructions: '', messages: [], maxSteps: 8,
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    tools: [{ name: 'read', category: 'read', description: '', parameters: {}, validate: () => {}, execute: async () => { effects++; return 'result'; } }],
  }), /Limite de tours/);
  assert.equal(requests, 8);
  assert.equal(effects, 3);
});

test('provider preserves a Gemini tool signature through the next agent request', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  const requests: any[] = [];
  const provider = new ChatProvider(async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    return fragmented(sse([{ choices: [{ delta: requests.length === 1 ? { tool_calls: [{ index: 0, id: 'sig', type: 'function', function: { name: 'read', arguments: '{}' }, extra_content: { google: { thought_signature: 'opaque-signature' } } }] } : { content: 'done' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }, '[DONE]']));
  });
  await runAgent({ provider, connection, instructions: '', messages: [], settings: { mode: 'auto', permission_mode: 'strict' }, confirm: async () => false,
    tools: [{ name: 'read', category: 'read', description: '', parameters: {}, validate: () => {}, execute: async () => 'read result' }],
  });
  assert.equal(requests[1].messages[1].tool_calls[0].extra_content.google.thought_signature, 'opaque-signature');
});

test('an empty successful provider payload is reported instead of silently ending the conversation', async () => {
  const { ChatProvider } = await import('../core/provider.mts');
  await assert.rejects(new ChatProvider(async () => fragmented(sse(['[DONE]']))).complete({ connection, messages: [] }), /vide/i);
});

test('real HTTP transport refuses redirects and cancellation closes a streaming request', async t => {
  const { ChatProvider } = await import('../core/provider.mts');
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
  const provider = new ChatProvider();
  await assert.rejects(provider.complete({ connection: { ...connection, base_url: `http://127.0.0.1:${port}/redirect` }, messages: [] }));
  assert.equal(redirectReached, false);
  const controller = new AbortController();
  const task = provider.complete({ connection: { ...connection, base_url: `http://127.0.0.1:${port}/v1` }, messages: [], signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(task, (e: any) => e.name === 'AbortError');
  await disconnected;
});
