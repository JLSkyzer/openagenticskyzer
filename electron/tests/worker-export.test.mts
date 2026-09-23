import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `t-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function project(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const folder = join(root, 'projet');
  await Promise.all([mkdir(home), mkdir(folder)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  return { worker, folder };
}

test('worker::export-conversation writes a real file at the project root, not in .openagent, and reports its filename', async t => {
  const { worker, folder } = await project(t);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Salut !' }] });
  const { filename } = await callWorker(worker, 'export-conversation', { folder, format: 'md', provider: 'test', model: 'm' });
  assert.match(filename, /^conversation_\d{8}_\d{6}\.md$/);
  const content = await readFile(join(folder, filename), 'utf8');
  assert.match(content, /^# Conversation — /);
  assert.match(content, /## 👤 Utilisateur\n\nBonjour/);
  assert.match(content, /## 🤖 Assistant\n\nSalut !/);
  const listing = await readdir(folder);
  assert.ok(listing.includes(filename), 'the file is at the project root');
  assert.equal(listing.includes('.openagent'), true, 'not confused with the metadata directory');
});

test('worker::export-conversation writes valid HTML and valid JSON too', async t => {
  const { worker, folder } = await project(t);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: [{ role: 'user', content: 'Bonjour' }] });
  const html = await callWorker(worker, 'export-conversation', { folder, format: 'html', provider: 'test', model: 'm' });
  const htmlContent = await readFile(join(folder, html.filename), 'utf8');
  assert.match(htmlContent, /^<!DOCTYPE html>/);
  assert.match(htmlContent, /Bonjour/);
  const json = await callWorker(worker, 'export-conversation', { folder, format: 'json', provider: 'test', model: 'm' });
  const data = JSON.parse(await readFile(join(folder, json.filename), 'utf8'));
  assert.deepEqual(data[0], { role: 'user', content: 'Bonjour', tool_name: null, tool_tag: null, tool_detail: null });
});

test('worker::export-conversation resolves a tool\'s tag from its REAL registered category, using a genuine create_file/run_command/read_file/internet_search conversation', async t => {
  const { worker, folder } = await project(t);
  const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  await callWorker(worker, 'save-messages', {
    folder, branchId: 'main',
    messages: [
      { role: 'user', content: 'crée un fichier' },
      { role: 'assistant', content: '', tool_calls: [call('c1', 'create_file', { path: 'a.txt', content: 'x' })] },
      { role: 'tool', tool_call_id: 'c1', content: 'Fichier créé.' },
      { role: 'assistant', content: '', tool_calls: [call('c2', 'run_command', { command: 'echo hi' })] },
      { role: 'tool', tool_call_id: 'c2', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call('c3', 'read_file', { path: 'a.txt' })] },
      { role: 'tool', tool_call_id: 'c3', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [call('c4', 'internet_search', { query: 'openagent' })] },
      { role: 'tool', tool_call_id: 'c4', content: 'résultats' },
    ],
  });
  const { filename } = await callWorker(worker, 'export-conversation', { folder, format: 'json', provider: 'test', model: 'm' });
  const data = JSON.parse(await readFile(join(folder, filename), 'utf8'));
  const tags = Object.fromEntries(data.filter((e: any) => e.tool_name).map((e: any) => [e.tool_name, e.tool_tag]));
  assert.deepEqual(tags, { create_file: 'write', run_command: 'run', read_file: 'read', internet_search: 'search' });
});

test('worker::export-conversation works on a conversation that was only ever saved to disk, never run live in this worker (no reliance on live tool-start events)', async t => {
  const { worker, folder } = await project(t);
  const call = { id: 'c1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'x' }) } };
  // save-messages alone, no `send` was ever called on this worker instance for this conversation.
  await callWorker(worker, 'save-messages', {
    folder, branchId: 'main',
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }],
  });
  const { filename } = await callWorker(worker, 'export-conversation', { folder, format: 'json', provider: 'test', model: 'm' });
  const data = JSON.parse(await readFile(join(folder, filename), 'utf8'));
  assert.equal(data.find((e: any) => e.tool_name === 'create_file').tool_tag, 'write');
});

test('worker::export-conversation exports a fork branch, distinct from main', async t => {
  const { worker, folder } = await project(t);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: [{ role: 'user', content: 'main' }] });
  const fork = await callWorker(worker, 'fork', { folder, source: 'main', count: 1, label: 'B' });
  await callWorker(worker, 'save-messages', { folder, branchId: fork.id, messages: [{ role: 'user', content: 'branche' }] });
  const { filename } = await callWorker(worker, 'export-conversation', { folder, branchId: fork.id, format: 'md', provider: 'test', model: 'm' });
  const content = await readFile(join(folder, filename), 'utf8');
  assert.match(content, /branche/);
  assert.equal(content.includes('main'), false);
});

test('worker::export-conversation refuses an invalid format and a missing folder, and writes nothing', async t => {
  const { worker, folder } = await project(t);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: [{ role: 'user', content: 'a' }] });
  await assert.rejects(callWorker(worker, 'export-conversation', { folder, format: 'exe', provider: 'p', model: 'm' }), /invalide/);
  await assert.rejects(callWorker(worker, 'export-conversation', { folder: join(folder, 'inexistant'), format: 'md', provider: 'p', model: 'm' }), /ENOENT|introuvable/);
  const listing = await readdir(folder);
  assert.equal(listing.some(name => name.startsWith('conversation_')), false, 'nothing was written on a refused request');
});
