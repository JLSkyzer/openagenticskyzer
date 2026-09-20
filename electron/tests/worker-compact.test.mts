import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { compactMessages } from '../core/compact.mts';

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

/** Resolves with the closing event of a compaction: 'compacted' or 'compact-failed'. */
function compactionOutcome(worker: Worker, compactionId: string): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message?.type !== 'event' || message.event !== 'agent' || message.runId !== compactionId) return;
      if (message.kind === 'compacted' || message.kind === 'compact-failed') { worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
  });
}

type Mode = 'summary' | 'empty' | 'blank' | 'error' | 'hold';

/** A fake model that records every request body and answers according to a switchable mode. */
async function fakeModel(t: { after(fn: () => unknown): void }) {
  const requests: any[] = [];
  const held: Array<{ response: ServerResponse; answer: () => void }> = [];
  let mode: Mode = 'summary';
  let onHeld: (() => void) | null = null;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      const answer = () => {
        if (mode === 'error') { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"boom"}'); return; }
        const content = mode === 'empty' ? '' : mode === 'blank' ? '  \n ' : '- décision : utiliser la branche A\n- fichier modifié : notes.md';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      };
      if (mode === 'hold') { held.push({ response, answer }); onHeld?.(); } else answer();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const h of held) h.response.destroy(); server.closeAllConnections?.(); server.close(() => resolve(undefined)); }));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    connection: { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' },
    set mode(value: Mode) { mode = value; },
    nextHeld() { return new Promise<void>(resolve => { onHeld = resolve; }); },
    release() { mode = 'summary'; for (const h of held.splice(0)) h.answer(); },
  };
}

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-compact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  const model = await fakeModel(t);
  const seed = (messages: unknown[], branchId = 'main') => callWorker(worker, 'save-messages', { folder: project, branchId, messages });
  const stored = (branchId = 'main') => callWorker(worker, 'messages', { folder: project, branchId });
  const compact = async (branchId = 'main') => {
    const { compactionId } = await callWorker(worker, 'compact', { folder: project, branchId, connection: model.connection });
    return { compactionId, outcome: compactionOutcome(worker, compactionId) };
  };
  return { worker, root, home, project, model, seed, stored, compact };
}

const say = (role: string, content: string) => ({ role, content });
const exchanges = (count: number) => Array.from({ length: count }, (_, i) => [say('user', `question ${i + 1}`), say('assistant', `réponse ${i + 1}`)]).flat();

test('worker::compact replaces the history with a summary plus the last exchange, and persists it on the branch', async t => {
  const { model, seed, stored, compact } = await setup(t);
  await seed(exchanges(4));
  const { outcome } = await compact();
  const done = await outcome;
  assert.equal(done.kind, 'compacted');
  const messages = await stored();
  assert.equal(messages.length, 3, 'summary + the last user message + its reply');
  assert.equal(messages[0].role, 'assistant');
  assert.match(messages[0].content, /^\*\*\[Résumé de contexte compressé\]\*\*\n\n- décision : utiliser la branche A/);
  assert.deepEqual(messages.slice(1).map((m: any) => m.content), ['question 4', 'réponse 4']);
  assert.deepEqual(done.messages, messages, 'the event carries exactly what was saved');
  assert.equal(model.requests.length, 1);
});

test('worker::compact asks the model with NO tool, and sends only the older user/assistant text (800 characters max each)', async t => {
  const { model, seed, compact } = await setup(t);
  const long = 'x'.repeat(2000);
  await seed([
    say('user', 'question 1'), say('assistant', long),
    say('user', 'question 2'), say('assistant', 'réponse 2'),
    say('user', 'question 3'), say('assistant', 'réponse 3'),
    say('user', 'dernière question'), say('assistant', 'dernière réponse'),
  ]);
  await (await compact()).outcome;
  const body = model.requests[0];
  assert.equal(body.tools, undefined, 'the summariser has no tool: the text it reads may carry an injection');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  const prompt: string = body.messages[0].content;
  assert.match(prompt, /^Résume cette conversation de manière dense et structurée\./);
  assert.match(prompt, /\[USER\]: question 1/);
  assert.match(prompt, /\[AI\]: réponse 3/);
  assert.ok(prompt.includes('x'.repeat(800)) && !prompt.includes('x'.repeat(801)), 'each message is cut at 800 characters');
  assert.equal(prompt.includes('dernière question'), false, 'the part that is kept is not summarised');
  assert.match(prompt, /RÉSUMÉ :$/);
});

test('worker::compact keeps a tool call together with its result: the kept part starts at the last user message', async t => {
  const { model, seed, stored, compact } = await setup(t);
  const toolCall = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
  await seed([
    ...exchanges(2),
    say('user', 'lis le fichier'), toolCall, { role: 'tool', tool_call_id: 'c1', content: 'CONTENU-OUTIL-SECRET' }, say('assistant', 'voilà'),
  ]);
  await (await compact()).outcome;
  const messages = await stored();
  assert.deepEqual(messages.slice(1).map((m: any) => m.role), ['user', 'assistant', 'tool', 'assistant'], 'no orphan tool message');
  assert.equal(messages[2].tool_calls[0].id, 'c1');
  assert.equal(messages[3].tool_call_id, 'c1');
  assert.equal(model.requests[0].messages[0].content.includes('CONTENU-OUTIL-SECRET'), false, 'tool output is not sent to the summariser');
});

test('worker::compact refuses a conversation that is too short, or a single long exchange, and changes nothing', async t => {
  const { worker, project, model, seed, stored } = await setup(t);
  await seed(exchanges(2));
  await assert.rejects(callWorker(worker, 'compact', { folder: project, branchId: 'main', connection: model.connection }), /Pas assez de messages/);
  const toolCall = { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
  const single = [say('user', 'fais tout'), toolCall, say('tool', 'a'), toolCall, say('tool', 'b'), say('assistant', 'fini')];
  await seed(single);
  await assert.rejects(callWorker(worker, 'compact', { folder: project, branchId: 'main', connection: model.connection }), /Pas assez de messages/, 'six messages but one single exchange: nothing to summarise');
  assert.deepEqual(await stored(), single);
  assert.equal(model.requests.length, 0, 'the model was never called');
});

test('worker::compact never writes the summary into memory.md (it would be re-injected in every future prompt)', async t => {
  const { home, project, seed, compact } = await setup(t);
  await seed(exchanges(4));
  await (await compact()).outcome;
  const listing = async (dir: string) => readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const all = [...await listing(home), ...await listing(join(project, '.openagent'))];
  assert.equal(all.some(entry => String(entry).endsWith('memory.md')), false, `no memory.md anywhere: ${JSON.stringify(all)}`);
});

test('worker::compact leaves the conversation untouched when the model fails (no destructive fallback)', async t => {
  const { model, seed, stored, compact } = await setup(t);
  const history = exchanges(5);
  await seed(history);
  model.mode = 'error';
  const done = await (await compact()).outcome;
  assert.equal(done.kind, 'compact-failed');
  assert.match(done.message, /\S/);
  assert.deepEqual(await stored(), history, 'not a single message was dropped');
});

test('worker::compact leaves the conversation untouched when the model returns nothing usable', async t => {
  const { model, seed, stored, compact } = await setup(t);
  const history = exchanges(5);
  await seed(history);
  // Nothing at all: the provider layer itself refuses it, with its own clear message.
  model.mode = 'empty';
  const empty = await (await compact()).outcome;
  assert.equal(empty.kind, 'compact-failed');
  assert.match(empty.message, /Réponse vide/);
  assert.deepEqual(await stored(), history);
  // Only whitespace: same outcome, the history is not replaced by a blank summary.
  model.mode = 'blank';
  const blank = await (await compact()).outcome;
  assert.equal(blank.kind, 'compact-failed');
  assert.match(blank.message, /Réponse vide/);
  assert.deepEqual(await stored(), history, 'a blank summary must never replace a real history');
});

test('compactMessages has its own guard: a blank summary from any provider is refused', async () => {
  // The real provider already rejects blank answers, so this guard cannot be reached through the worker:
  // it is checked directly, with a provider that lets a blank answer through.
  const blankProvider = { complete: async () => ({ role: 'assistant' as const, content: '  \n ' }) };
  await assert.rejects(
    compactMessages({ provider: blankProvider, connection: { provider: 'test', model: 'm', base_url: 'http://x', api_key: '' }, messages: exchanges(5) }),
    /aucun résumé/,
  );
});

test('worker::compact does not overwrite a conversation that changed while the model was summarising', async t => {
  const { worker, project, model, seed, stored, compact } = await setup(t);
  await seed(exchanges(5));
  model.mode = 'hold';
  const held = model.nextHeld();
  const { outcome } = await compact();
  await held;
  // "clear-history" is now refused during a compaction (see project-memory.test.mts): another writer is used,
  // `save-messages`, to prove the compare-and-set itself — it protects against ANY concurrent write.
  const rewritten = [{ role: 'user', content: 'réécrit ailleurs' }];
  await callWorker(worker, 'save-messages', { folder: project, branchId: 'main', messages: rewritten });
  model.release();
  const done = await outcome;
  assert.equal(done.kind, 'compact-failed');
  assert.match(done.message, /a changé pendant la compaction/);
  assert.deepEqual(await stored(), rewritten, 'what was written meanwhile stays: the late summary was NOT written back');
});

test('worker::compact is refused while another compaction runs on the folder, and blocks send and fork meanwhile', async t => {
  const { worker, project, model, seed, compact } = await setup(t);
  await seed(exchanges(5));
  model.mode = 'hold';
  const held = model.nextHeld();
  const { outcome } = await compact();
  await held;
  await assert.rejects(callWorker(worker, 'compact', { folder: project, branchId: 'main', connection: model.connection }), /déjà en cours/);
  await assert.rejects(callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'salut', connection: model.connection }), /compaction est en cours/);
  await assert.rejects(callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Trop tôt' }), /en cours/);
  model.release();
  assert.equal((await outcome).kind, 'compacted');
  // Once finished the folder is usable again.
  assert.equal((await callWorker(worker, 'fork', { folder: project, source: 'main', count: 1, label: 'Après' })).label, 'Après');
});

test('worker::compact is refused while an agent run is in flight on the folder', async t => {
  const { worker, project, model, seed } = await setup(t);
  await seed(exchanges(5));
  model.mode = 'hold';
  const held = model.nextHeld();
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'en cours', connection: model.connection });
  await held;
  await assert.rejects(callWorker(worker, 'compact', { folder: project, branchId: 'main', connection: model.connection }), /en cours/);
  await callWorker(worker, 'stop', { runId });
});

test('worker::compact works on a fork too, and leaves main untouched', async t => {
  const { worker, project, seed, stored, compact } = await setup(t);
  await seed(exchanges(5));
  const mainBefore = await stored();
  const fork = await callWorker(worker, 'fork', { folder: project, source: 'main', count: 10, label: 'Branche 1' });
  await (await compact(fork.id)).outcome;
  assert.equal((await stored(fork.id)).length, 3);
  assert.deepEqual(await stored(), mainBefore);
});
