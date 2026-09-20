import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { readProjectMemory, MEMORY_DISPLAY_LIMIT } from '../core/project-memory.mts';

async function project(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-project-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'projet');
  await mkdir(join(folder, '.openagent'), { recursive: true });
  return { root, folder };
}

test('a project with no memory.md has an empty memory, not an error', async t => {
  const { folder } = await project(t);
  assert.deepEqual(await readProjectMemory(folder), { content: '', truncated: false });
  await rm(join(folder, '.openagent'), { recursive: true });
  assert.deepEqual(await readProjectMemory(folder), { content: '', truncated: false }, 'nor without any .openagent directory');
});

test('the memory is returned as written', async t => {
  const { folder } = await project(t);
  await writeFile(join(folder, '.openagent', 'memory.md'), '# Faits\n- utilise pnpm\n- écrit en français\n');
  assert.deepEqual(await readProjectMemory(folder), { content: '# Faits\n- utilise pnpm\n- écrit en français\n', truncated: false });
});

test('a very large memory is cut to its END (the recent facts are appended last) and says so', async t => {
  const { folder } = await project(t);
  const body = `${'ancien '.repeat(60_000)}DERNIER-FAIT`;
  await writeFile(join(folder, '.openagent', 'memory.md'), body);
  const result = await readProjectMemory(folder);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, MEMORY_DISPLAY_LIMIT);
  assert.ok(result.content.endsWith('DERNIER-FAIT'), 'the end of the file is what is kept');
});

test('a huge file is not read in full', async t => {
  const { folder } = await project(t);
  await writeFile(join(folder, '.openagent', 'memory.md'), `${'x'.repeat(7_000_000)}FIN`);
  const result = await readProjectMemory(folder);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, MEMORY_DISPLAY_LIMIT);
  assert.ok(result.content.endsWith('FIN'));
});

// A symbolic link is refused by the very same check (lstat().isFile() is false for a link), but creating a
// file symlink needs a privilege this machine does not grant, so it cannot be exercised here — and a test
// that skips itself proves nothing. A directory named memory.md takes the same branch and is tested.
test('a memory.md that is not a regular file is refused (a link, a directory…)', async t => {
  const { folder } = await project(t);
  await mkdir(join(folder, '.openagent', 'memory.md'));
  await assert.rejects(readProjectMemory(folder), /non régulière/);
});

test('a .openagent directory redirected by a junction is refused', async t => {
  const { root, folder } = await project(t);
  await mkdir(join(root, 'ailleurs'));
  await writeFile(join(root, 'ailleurs', 'memory.md'), 'hors du projet');
  await rm(join(folder, '.openagent'), { recursive: true });
  await symlink(join(root, 'ailleurs'), join(folder, '.openagent'), 'junction');
  await assert.rejects(readProjectMemory(folder), /redirigé/);
});

test('a relative or missing folder is refused', async () => {
  await assert.rejects(readProjectMemory('relatif/dossier'), /absolu/);
  await assert.rejects(readProjectMemory(join(tmpdir(), 'openagent-dossier-qui-n-existe-pas')), /ENOENT|introuvable/);
});

// ── through the worker ────────────────────────────────────────────────────────

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

test('worker::read-project-memory serves the memory of the folder', async t => {
  const { root, folder } = await project(t);
  await writeFile(join(folder, '.openagent', 'memory.md'), 'un fait');
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: join(root, 'home') } });
  t.after(() => worker.terminate());
  assert.deepEqual(await callWorker(worker, 'read-project-memory', { folder }), { content: 'un fait', truncated: false });
});

// ── clear-history must not run under an agent run or a compaction ────────────

async function fakeModel(t: { after(fn: () => unknown): void }) {
  const held: Array<{ response: ServerResponse; answer: () => void }> = [];
  let onHeld: (() => void) | null = null;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer = () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: '- résumé' }, finish_reason: 'stop' }] })); };
      held.push({ response, answer });
      onHeld?.();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const h of held) h.response.destroy(); server.closeAllConnections?.(); server.close(() => resolve(undefined)); }));
  const port = (server.address() as { port: number }).port;
  return {
    connection: { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'm', api_key: 'fake' },
    nextHeld: () => new Promise<void>(resolve => { onHeld = resolve; }),
    release: () => { for (const h of held.splice(0)) h.answer(); },
  };
}

test('worker::clear-history is refused while an agent run holds the folder, then accepted', async t => {
  const { root, folder } = await project(t);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: join(root, 'home') } });
  t.after(() => worker.terminate());
  const model = await fakeModel(t);
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  const held = model.nextHeld();
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'en cours', connection: model.connection });
  await held;
  await assert.rejects(callWorker(worker, 'clear-history', { folder }), /en cours/);
  assert.equal((await callWorker(worker, 'messages', { folder, branchId: 'main' })).length, 2, 'the refused clear removed nothing');
  await callWorker(worker, 'stop', { runId });
  // The run ends asynchronously after Stop: wait until the folder is free again.
  for (let i = 0; i < 100; i++) {
    try { await callWorker(worker, 'clear-history', { folder }); break; } catch (error: any) { if (!/en cours/.test(error.message)) throw error; await new Promise(r => setTimeout(r, 30)); }
  }
  assert.deepEqual(await callWorker(worker, 'messages', { folder, branchId: 'main' }), [], 'once the run ended the history could be cleared');
});

test('worker::clear-history is refused while a compaction holds the folder', async t => {
  const { root, folder } = await project(t);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: join(root, 'home') } });
  t.after(() => worker.terminate());
  const model = await fakeModel(t);
  const messages = Array.from({ length: 5 }, (_, i) => [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `r${i}` }]).flat();
  await callWorker(worker, 'save-messages', { folder, branchId: 'main', messages });
  const held = model.nextHeld();
  const finished = new Promise<void>(resolve => {
    const listener = (message: any) => { if (message?.event === 'agent' && (message.kind === 'compacted' || message.kind === 'compact-failed')) { worker.off('message', listener); resolve(); } };
    worker.on('message', listener);
  });
  await callWorker(worker, 'compact', { folder, branchId: 'main', connection: model.connection });
  await held;
  await assert.rejects(callWorker(worker, 'clear-history', { folder }), /en cours/);
  model.release();
  await finished;
  assert.equal((await callWorker(worker, 'clear-history', { folder })).removed_messages, 3, 'freed once the summary is saved');
});
