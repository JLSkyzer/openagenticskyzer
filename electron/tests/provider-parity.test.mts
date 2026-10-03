import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const { ChatProvider, OUTPUT_CAPS, outputCap, retryAfterMs, errorDetail, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_RETRY_DELAYS_MS } = await import('../core/provider.mts');
const { runAgent } = await import('../core/agent.mts');

const KEY = 'sk-test-SECRET-123';
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A real OpenAI-compatible server on 127.0.0.1: request N gets handlers[N], the last one repeats. */
async function serve(t: any, handlers: Handler[]) {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(raw ? JSON.parse(raw) : null);
      handlers[Math.min(bodies.length - 1, handlers.length - 1)](request, response);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const connection = (provider = 'openrouter') => ({ provider, base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: KEY });
  return { bodies, connection };
}
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const json = (body: unknown): Handler => (_q, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const reply = (content: string, finish = 'stop') => json({ choices: [{ message: { content }, finish_reason: finish }] });
const failure = (status: number, body: string, headers: Record<string, string> = {}): Handler => (_q, response) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body);
};

test('max_tokens follows Python\'s per-provider cap, and is not sent at all for ollama', async t => {
  const { bodies, connection } = await serve(t, [reply('ok')]);
  const provider = new ChatProvider();
  const expected: Record<string, number | undefined> = {
    together: 16384, mistral: 16384, gemini: 16384, openrouter: 16384, groq: 8192, lmstudio: 8192, llamacpp: 8192, ollama: undefined,
  };
  for (const id of Object.keys(expected)) await provider.complete({ connection: connection(id), messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(bodies.map(body => body.max_tokens), Object.values(expected));
  assert.equal('max_tokens' in bodies.at(-1), false, 'ollama: the key itself is absent');
  assert.deepEqual({ ...OUTPUT_CAPS }, { together: 16384, mistral: 16384, gemini: 16384, openrouter: 16384, groq: 8192, lmstudio: 8192, llamacpp: 8192 });
  assert.equal(outputCap('inconnu'), undefined);
  assert.equal(outputCap('constructor'), undefined, 'never an inherited property');
});

test('an agent turn sends the provider cap, never reserved_tokens', async t => {
  const { bodies, connection } = await serve(t, [reply('ok')]);
  await runAgent({
    provider: new ChatProvider(), connection: connection('groq'), messages: [{ role: 'user', content: 'x' }], instructions: '', tools: [],
    settings: { mode: 'auto', permission_mode: 'auto', reserved_tokens: 2048 }, confirm: async () => true,
  });
  assert.equal(bodies[0].max_tokens, 8192);
});

test('finish_reason "length" returns what was received, flagged truncated, instead of failing', async t => {
  const { connection } = await serve(t, [
    (_q, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse({ choices: [{ delta: { content: 'Début ' } }] }) + sse({ choices: [{ delta: { content: 'coupé' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n');
    },
    reply('', 'length'),
    reply('filtré', 'content_filter'),
  ]);
  const provider = new ChatProvider();
  assert.deepEqual(await provider.complete({ connection: connection(), messages: [] }), { role: 'assistant', content: 'Début coupé', truncated: true });
  assert.deepEqual(await provider.complete({ connection: connection(), messages: [] }), { role: 'assistant', content: '', truncated: true }, 'a cap spent entirely on thinking is not "Réponse vide"');
  await assert.rejects(provider.complete({ connection: connection(), messages: [] }), { message: 'Réponse interrompue par le provider (content_filter)' });
});

test('a provider error says what the provider said, at most 500 characters, with the API key masked', async t => {
  const { connection } = await serve(t, [
    failure(400, JSON.stringify({ error: { message: 'context length exceeded' } })),
    failure(400, JSON.stringify({ error: { message: `bad key ${KEY} refused` } })),
    failure(400, 'y'.repeat(2000)),
    failure(401, 'invalid api key'),
    failure(500, ''),
    (_q, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse({ error: { code: 'overloaded', message: `busy for ${KEY}` } })); },
  ]);
  const provider = new ChatProvider(undefined, { retryDelaysMs: [] });
  const ask = () => provider.complete({ connection: connection(), messages: [] });
  await assert.rejects(ask(), { message: 'Erreur du provider (400) : context length exceeded' });
  await assert.rejects(ask(), { message: 'Erreur du provider (400) : bad key *** refused' });
  await assert.rejects(ask(), { message: `Erreur du provider (400) : ${'y'.repeat(500)}` });
  await assert.rejects(ask(), { message: 'Erreur du provider (401) : invalid api key — authentification refusée, vérifiez la connexion du projet' });
  await assert.rejects(ask(), { message: 'Erreur du provider (500).' });
  await assert.rejects(ask(), { message: 'Erreur du provider (overloaded) : busy for ***' });
});

test('errorDetail reads error.message or an error string, masks the key BEFORE cutting, and keeps 500 characters', () => {
  assert.equal(errorDetail('{"error":"boom"}', ''), 'boom');
  // A real newline inside a JSON string must be escaped, or the JSON is invalid and the raw text is shown instead.
  assert.equal(errorDetail('{"error":{"message":"  a\\n b "}}', ''), 'a b');
  assert.equal(errorDetail('{"other":1}', ''), '{"other":1}');
  assert.equal(errorDetail('a'.repeat(498) + 'sk-SECRET', 'sk-SECRET'), 'a'.repeat(498) + '**', 'not even a fragment of the key survives the cut');
});

test('Retry-After is read in seconds or as an HTTP date, and capped at 30 s', () => {
  const now = Date.parse('2026-10-03T10:00:00Z');
  assert.equal(retryAfterMs('2', now), 2000);
  assert.equal(retryAfterMs('120', now), 30000);
  assert.equal(retryAfterMs('Sat, 03 Oct 2026 10:00:05 GMT', now), 5000);
  assert.equal(retryAfterMs('demain', now), null);
  assert.equal(retryAfterMs(null, now), null);
  assert.deepEqual([...DEFAULT_RETRY_DELAYS_MS], [1000, 3000]);
});

test('503 then 200: retried once after the default first delay (1 s), and succeeds', async t => {
  const { bodies, connection } = await serve(t, [failure(503, 'busy'), reply('ok')]);
  const started = Date.now();
  const answer = await new ChatProvider().complete({ connection: connection(), messages: [] });
  const elapsed = Date.now() - started;
  assert.equal(answer.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.ok(elapsed >= 950 && elapsed < 2900, `first retry after about 1 s, got ${elapsed} ms`);
});

test('429 with Retry-After: 1 waits that second instead of the configured delay', async t => {
  const { bodies, connection } = await serve(t, [failure(429, 'slow down', { 'retry-after': '1' }), reply('ok')]);
  const started = Date.now();
  await new ChatProvider(undefined, { retryDelaysMs: [5000, 5000] }).complete({ connection: connection(), messages: [] });
  const elapsed = Date.now() - started;
  assert.equal(bodies.length, 2);
  assert.ok(elapsed >= 950 && elapsed < 4000, `Retry-After respected, got ${elapsed} ms`);
});

test('503 three times: two retries, then the error; a 400 is never retried', async t => {
  const down = await serve(t, [failure(503, 'down')]);
  await assert.rejects(new ChatProvider(undefined, { retryDelaysMs: [20, 20] }).complete({ connection: down.connection(), messages: [] }), { message: 'Erreur du provider (503) : down' });
  assert.equal(down.bodies.length, 3);
  const bad = await serve(t, [failure(400, 'bad')]);
  await assert.rejects(new ChatProvider(undefined, { retryDelaysMs: [20, 20] }).complete({ connection: bad.connection(), messages: [] }));
  assert.equal(bad.bodies.length, 1);
});

test('a connection cut before the first byte is retried', async t => {
  const { bodies, connection } = await serve(t, [request => { request.socket.destroy(); }, reply('ok')]);
  const answer = await new ChatProvider(undefined, { retryDelaysMs: [20, 20] }).complete({ connection: connection(), messages: [] });
  assert.equal(answer.content, 'ok');
  assert.equal(bodies.length, 2);
});

test('a Stop during the wait between two attempts ends it at once', async t => {
  const { bodies, connection } = await serve(t, [failure(503, 'busy', { 'retry-after': '30' })]);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(new ChatProvider().complete({ connection: connection(), messages: [], signal: controller.signal }), (e: any) => e.name === 'AbortError');
  assert.ok(Date.now() - started < 2000, 'the 30 s wait was interrupted');
  assert.equal(bodies.length, 1);
});

test('a silent provider expires after the idle delay; a slow but living stream is never cut', async t => {
  const { connection } = await serve(t, [
    (_q, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ choices: [{ delta: { content: 'partiel' } }] }));
      // then nothing: the provider has gone silent
    },
    (_q, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (n < 6) response.write(sse({ choices: [{ delta: { content: String(n) } }] }));
        else { clearInterval(timer); response.end(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); }
      }, 150);
    },
  ]);
  const provider = new ChatProvider(undefined, { idleTimeoutMs: 400 });
  const deltas: string[] = [];
  await assert.rejects(provider.complete({ connection: connection(), messages: [], onDelta: text => deltas.push(text) }), { message: 'Le fournisseur ne répond plus (0.4 s)' });
  assert.deepEqual(deltas, ['partiel'], 'what arrived before the silence was streamed (the worker keeps it)');
  const living = await provider.complete({ connection: connection(), messages: [] });
  assert.equal(living.content, '12345', '900 ms in total, never 400 ms without a byte');
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 120000);
});

test('a reply cut inside a parallel call that has only just started drops that fragment: the turn never fails', async t => {
  const { defineTool } = await import('../core/tool-kit.mts');
  const stream = (calls: unknown[]) => (_q: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n');
  };
  const first = { index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } };
  // The cap landed in the very first delta of the second call: only its id, only its name, or only an index.
  for (const started of [{ index: 1, id: 'c2' }, { index: 1, function: { name: 'echo' } }, { index: 1 }]) {
    const { bodies, connection } = await serve(t, [stream([first, started]), reply('repris')]);
    const ran: unknown[] = [];
    const echo = defineTool({ name: 'echo', description: 'écho', category: 'read', properties: { text: { type: 'string' } }, required: ['text'], execute: async args => { ran.push(args); return 'ok'; } });
    const result = await runAgent({
      provider: new ChatProvider(), connection: connection(), messages: [{ role: 'user', content: 'x' }], instructions: '', tools: [echo],
      settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    });
    assert.equal(bodies.length, 2, `the turn went on (${JSON.stringify(started)})`);
    assert.deepEqual(ran, [], 'a truncated call is never run');
    const sent = bodies[1].messages.find((m: any) => m.tool_calls);
    assert.deepEqual(sent.tool_calls.map((c: any) => c.id), ['c1'], 'only the complete-looking call is kept');
    assert.equal(bodies[1].messages.filter((m: any) => m.role === 'tool')[0].content, 'Erreur : arguments tronqués par la limite de sortie — découpe le travail en appels plus petits');
    assert.equal(result.at(-1)?.content, 'repris');
  }
  // Without a truncation the same fragment is still a malformed reply.
  const { connection } = await serve(t, [(_q, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2' }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  }]);
  await assert.rejects(new ChatProvider().complete({ connection: connection(), messages: [] }), { message: 'Appel outil invalide' });
});

test('Retry-After: decimal seconds are seconds, a negative or unreadable value falls back to the default delay', () => {
  const now = Date.parse('2026-10-03T10:00:00Z');
  assert.equal(retryAfterMs('0.5', now), 500);
  assert.equal(retryAfterMs('1.25', now), 1250);
  assert.equal(retryAfterMs('0', now), 0);
  for (const bad of ['-1', '-1.5', '1e3', '2 s', '.5', '5.', '1,5']) assert.equal(retryAfterMs(bad, now), null, bad);
  assert.equal(retryAfterMs('Sat, 03 Oct 2026 10:00:05 GMT', now), 5000, 'an HTTP date still works');
});
