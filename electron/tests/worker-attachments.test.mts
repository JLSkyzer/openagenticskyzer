import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `att-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}
async function waitDone(worker: Worker, runId: string) {
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.runId === runId && ['done', 'error', 'stopped'].includes(message.kind)) { worker.off('message', listener); resolve(); }
    };
    worker.on('message', listener);
  });
}

const TEXT = { name: 'notes.txt', content_type: 'text', content: 'FICHIER-SECRET-42', size_kb: 1 };
const IMAGE = { name: 'p.png', content_type: 'image', content: 'data:image/png;base64,QQ==', size_kb: 1 };

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-attachments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const seen: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      seen.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'vu' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'm', api_key: 'fake' };
  const send = async (payload: Record<string, unknown>) => {
    const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', connection, ...payload });
    await waitDone(worker, runId);
  };
  const saved = () => callWorker(worker, 'messages', { folder, branchId: 'main' });
  return { worker, folder, seen, send, saved };
}
const lastUser = (request: any) => [...request.messages].reverse().find((m: any) => m.role === 'user');

test('a text file goes to the model as a "--- name ---" block before the question, and is saved beside what was typed', async t => {
  const { seen, send, saved } = await setup(t);
  await send({ text: 'résume', attachments: [TEXT] });
  assert.equal(lastUser(seen[0]).content, '--- notes.txt ---\nFICHIER-SECRET-42\n---\n\nrésume');
  assert.equal('attachments' in lastUser(seen[0]), false, 'the field itself is never sent to the provider');
  const [user] = await saved();
  assert.equal(user.content, 'résume', 'the saved text is only what was typed');
  assert.deepEqual(user.attachments, [TEXT]);
});

test('an image goes as an image_url part followed by the text part; the data URI is kept in the saved message', async t => {
  const { seen, send, saved } = await setup(t);
  await send({ text: 'décris', attachments: [IMAGE] });
  assert.deepEqual(lastUser(seen[0]).content, [{ type: 'image_url', image_url: { url: IMAGE.content } }, { type: 'text', text: 'décris' }]);
  assert.deepEqual((await saved())[0].attachments, [IMAGE]);
});

test('a LATER turn still shows the model the earlier files (they are rebuilt from the saved transcript)', async t => {
  const { seen, send } = await setup(t);
  await send({ text: 'lis ça', attachments: [TEXT] });
  await send({ text: 'et maintenant ?' });
  const firstUser = seen[1].messages.find((m: any) => m.role === 'user');
  assert.match(firstUser.content, /FICHIER-SECRET-42/, 'the file is still there on the second turn');
  assert.equal(lastUser(seen[1]).content, 'et maintenant ?');
});

test('a message without attachments is saved and sent exactly as before (no attachments field at all)', async t => {
  const { seen, send, saved } = await setup(t);
  await send({ text: 'salut' });
  assert.equal(lastUser(seen[0]).content, 'salut');
  assert.equal('attachments' in (await saved())[0], false);
  await send({ text: 'liste vide', attachments: [] });
  assert.equal('attachments' in (await saved())[2], false, 'an empty list is not stored either');
});

test('bad attachments are refused BEFORE anything starts: no model call, nothing saved', async t => {
  const { worker, folder, seen, saved } = await setup(t);
  const attempt = (attachments: unknown) => callWorker(worker, 'send', { folder, branchId: 'main', text: 'x', attachments, connection: { provider: 'test', base_url: 'http://127.0.0.1:1/v1', model: 'm', api_key: 'k' } });
  await assert.rejects(attempt('pas une liste'), /Pièces? jointes? invalides?/);
  await assert.rejects(attempt([{ ...TEXT, content_type: 'exe' }]), /Pièce jointe invalide/);
  await assert.rejects(attempt([{ ...IMAGE, content: 'http://169.254.169.254/latest/meta-data' }]), /Pièce jointe invalide/, 'an image URL the provider would fetch is refused');
  assert.equal(seen.length, 0, 'no turn was started');
  assert.deepEqual(await saved(), [], 'nothing was saved');
});

test('regenerating (keep) can send the message again WITH its attachments', async t => {
  const { seen, send, saved } = await setup(t);
  await send({ text: 'résume', attachments: [TEXT] });
  await send({ text: 'résume', attachments: [TEXT], keep: 0 });
  assert.equal(lastUser(seen[1]).content, '--- notes.txt ---\nFICHIER-SECRET-42\n---\n\nrésume');
  const messages = await saved();
  assert.equal(messages.length, 2, 'the first turn was replaced, not appended to');
  assert.deepEqual(messages[0].attachments, [TEXT]);
});
