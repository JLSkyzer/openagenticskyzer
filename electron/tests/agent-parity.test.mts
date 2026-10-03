import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runAgent, TRUNCATED_NOTICE, DEFAULT_MAX_STEPS, MAX_STEPS_LIMIT } = await import('../core/agent.mts');
const { ChatProvider } = await import('../core/provider.mts');
const { workspaceTools } = await import('../core/workspace.mts');
const { shellTools } = await import('../core/shell-tool.mts');
const { defineTool } = await import('../core/tool-kit.mts');

/** Every assistant tool call's `arguments` that is not a JSON object: what a provider that parses them answers 400 to. */
function unreadableArguments(body: any): string[] {
  const bad: string[] = [];
  for (const message of body.messages ?? []) {
    for (const call of message.role === 'assistant' ? message.tool_calls ?? [] : []) {
      let parsed: unknown;
      try { parsed = JSON.parse(call.function.arguments); } catch { bad.push(call.function.arguments); continue; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) bad.push(call.function.arguments);
    }
  }
  return bad;
}

/** A real OpenAI-compatible server: request N is answered with next(N). Like providers that parse the assistant's
 * tool-call arguments, it refuses (400) a request carrying arguments that are not a JSON object. */
async function scriptedModel(t: any, next: (index: number) => unknown) {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(raw));
      const bad = unreadableArguments(bodies.at(-1));
      if (bad.length) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `invalid tool call arguments: ${bad[0]}` } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(next(bodies.length - 1)));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  return { bodies, connection: { provider: 'openrouter', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake-key' } };
}
const callAnswer = (id: string, name: string, args: string, finish = 'tool_calls') =>
  ({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] }, finish_reason: finish }] });
const textAnswer = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }] });
const auto = { mode: 'auto' as const, permission_mode: 'auto' as const };
const toolResults = (body: any) => body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
const carriesFlag = (messages: any[]) => messages.some(m => Object.hasOwn(m, 'truncated'));
async function project(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-agent-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const step = (count: { runs: number }) => defineTool({
  name: 'step', description: 'une étape', category: 'read', properties: { n: { type: 'integer' } }, required: ['n'],
  execute: async () => `étape ${++count.runs}`,
});

test('a reply cut by the output limit ends the turn with its text and a visible notice', async t => {
  const { bodies, connection } = await scriptedModel(t, () => textAnswer('Voici le début du composant', 'length'));
  const result = await runAgent({ provider: new ChatProvider(), connection, messages: [{ role: 'user', content: 'écris un long composant' }], instructions: '', tools: [], settings: auto, confirm: async () => true });
  assert.equal(bodies.length, 1, 'the turn ended: no new request');
  assert.equal(TRUNCATED_NOTICE, '[Réponse tronquée : limite de sortie atteinte]');
  assert.deepEqual(result.at(-1), { role: 'assistant', content: `Voici le début du composant\n\n${TRUNCATED_NOTICE}` }, 'the flag itself is never stored');
  assert.equal(carriesFlag(result), false, 'no message of the transcript carries the flag');
});

test('a tool call cut by the output limit is never executed: the model gets the error and the turn goes on', async t => {
  const root = await project(t);
  const { bodies, connection } = await scriptedModel(t, index => index === 0
    ? callAnswer('c1', 'create_file', '{"path":"composant.tsx","content":"export default function', 'length')
    : textAnswer('Je découpe en plusieurs fichiers.'));
  const emitted: any[] = [];
  const result = await runAgent({ provider: new ChatProvider(), connection, messages: [{ role: 'user', content: 'crée le composant' }], instructions: '', tools: await workspaceTools(root, ''), settings: auto, confirm: async () => true, emit: event => emitted.push(event) });
  await assert.rejects(stat(join(root, 'composant.tsx')), 'nothing was written, even with every permission granted');
  assert.deepEqual(toolResults(bodies[1]), ['Erreur : arguments tronqués par la limite de sortie — découpe le travail en appels plus petits']);
  assert.equal(bodies[1].messages.find((m: any) => m.tool_calls).content, TRUNCATED_NOTICE);
  assert.equal(result.at(-1)?.content, 'Je découpe en plusieurs fichiers.');
  // Only the request is repaired: the cut call went out as "{}", the transcript (what the worker saves) and the screen keep it as it came.
  const cut = '{"path":"composant.tsx","content":"export default function';
  assert.equal(bodies[1].messages.find((m: any) => m.tool_calls).tool_calls[0].function.arguments, '{}');
  assert.equal(result.find(m => m.tool_calls)?.tool_calls?.[0].function.arguments, cut, 'the saved transcript keeps the original cut arguments');
  assert.equal(emitted.find(e => e.type === 'message' && e.message.tool_calls).message.tool_calls[0].function.arguments, cut, 'so does the screen');
  assert.equal(carriesFlag(result), false, 'the transcript never holds the flag');
  assert.equal(carriesFlag(bodies[1].messages), false, 'the next request never sends the flag');
  assert.equal(carriesFlag(emitted.filter(e => e.type === 'message').map(e => e.message)), false, 'nor does the screen receive it');
});

test('30 tool calls in one turn complete under the default limit (it was 24)', async t => {
  const { bodies, connection } = await scriptedModel(t, index => index < 30 ? callAnswer(`c${index}`, 'step', JSON.stringify({ n: index + 1 })) : textAnswer('Fini.'));
  const count = { runs: 0 };
  const result = await runAgent({ provider: new ChatProvider(), connection, messages: [{ role: 'user', content: 'travaille' }], instructions: '', tools: [step(count)], settings: auto, confirm: async () => true });
  assert.equal(DEFAULT_MAX_STEPS, 100);
  assert.equal(count.runs, 30);
  assert.equal(bodies.length, 31);
  assert.equal(result.at(-1)?.content, 'Fini.');
});

test('the limit is accepted up to 150, refused at 151, and reaching it says how to resume', async t => {
  const { connection } = await scriptedModel(t, index => callAnswer(`c${index}`, 'step', JSON.stringify({ n: index + 1 })));
  const base = { provider: new ChatProvider(), connection, messages: [{ role: 'user' as const, content: 'x' }], instructions: '', tools: [step({ runs: 0 })], settings: auto, confirm: async () => true };
  assert.equal(MAX_STEPS_LIMIT, 150);
  await assert.rejects(runAgent({ ...base, maxSteps: 151 }), { message: 'Limite de tours invalide' });
  await assert.rejects(runAgent({ ...base, maxSteps: 150 }), /^Error: Limite de tours atteinte \(150 appels au modèle\)/);
  await assert.rejects(runAgent({ ...base, maxSteps: 3 }), { message: 'Limite de tours atteinte (3 appels au modèle). La génération a été arrêtée — réponds « continue » pour reprendre.' });
});

test('tool arguments: lenient numbers, extra keys dropped, and a refusal that names the field — seen by the model', async t => {
  const root = await project(t);
  const command = `node -e "console.log('coerce-ok')"`;
  const script = [
    callAnswer('c1', 'run_command', JSON.stringify({ command, timeout: '120', encoding: 'utf8' })),
    callAnswer('c2', 'run_command', JSON.stringify({ command, timeout: 'beaucoup' })),
    callAnswer('c3', 'run_command', JSON.stringify({ timeout: 5 })),
    callAnswer('c4', 'run_command', '{"command": '),
    textAnswer('fin'),
  ];
  const { bodies, connection } = await scriptedModel(t, index => script[index]);
  await runAgent({ provider: new ChatProvider(), connection, messages: [{ role: 'user', content: 'lance' }], instructions: '', tools: await shellTools(root), settings: auto, confirm: async () => true });
  assert.deepEqual(toolResults(bodies[4]), [
    'coerce-ok',
    'Erreur : Arguments invalides pour run_command : timeout doit être un entier entre 1 et 600',
    'Erreur : Arguments invalides pour run_command : command est requis',
    'Erreur : Arguments invalides pour run_command : JSON illisible',
  ]);
});
