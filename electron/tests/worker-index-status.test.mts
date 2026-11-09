import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { TEST_PROVIDER_MODULE } from './support/test-model-provider.mts';
import { PERF_LEVERS_ENV } from '../core/perf-levers.mts';

function callWorker(worker: Worker, op: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `idx-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

async function untilReady(worker: Worker, folder: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await callWorker(worker, 'index-status', { folder });
    if (status.state === 'ready' || status.state === 'error') return status;
    if (Date.now() > deadline) throw new Error(`timed out waiting for index-status, last: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('activate_folder triggers real automatic indexing, observable through index-status', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

  assert.deepEqual(await callWorker(worker, 'index-status', { folder: project }), { state: 'idle' });
  await callWorker(worker, 'activate_folder', { folder: project });
  const status = await untilReady(worker, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));

  const { storePath } = await import('../core/semantic-index.mts');
  await access(await storePath(project)); // the real store was really written to disk
});

test('worker startup indexes the last-used folder automatically when restore_last_folder is on', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-startup-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const first = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(first, 'activate_folder', { folder: project });
  await untilReady(first, project);
  await first.terminate();

  // A fresh worker on the SAME home, restore_last_folder still at its default (true) — must
  // index the last-used folder on its own, with no activate_folder call at all this time.
  const second = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, second);
  const status = await untilReady(second, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));
});

test('worker startup does NOT index anything when restore_last_folder is off', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-norestore-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');

  const first = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(first, 'activate_folder', { folder: project });
  await untilReady(first, project);
  await callWorker(first, 'save-global-settings', { patch: { restore_last_folder: false } });
  await first.terminate();

  const { storePath } = await import('../core/semantic-index.mts');
  await rm(await storePath(project), { force: true }); // clear the store the first worker already built

  const second = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, second);
  await new Promise(resolve => setTimeout(resolve, 500)); // give a real (wrongly) triggered index a chance to start
  assert.deepEqual(await callWorker(second, 'index-status', { folder: project }), { state: 'idle' });
  await assert.rejects(access(await storePath(project)), 'the store must never have been rebuilt');
});

test('index-status for a folder that was never activated is idle, not an error', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-idle-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  await mkdir(home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

  assert.deepEqual(await callWorker(worker, 'index-status', { folder: join(root, 'never-touched') }), { state: 'idle' });
});

test("the automatic indexing applies the project's ignored patterns and the secret-file filter, and purges an older index of them", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-filter-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(join(project, 'private'), { recursive: true }), mkdir(join(project, '.openagent', 'index'), { recursive: true })]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');
  await writeFile(join(project, 'secrets.json'), '{"key": "SECRET-WORKER-1"}');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-WORKER-2');
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ ignored_patterns: 'private/' }));
  await writeFile(join(project, '.openagent', 'index', 'codebase.json'), JSON.stringify({ version: 1, entries: [
    { id: 'secrets.json:0', file: 'secrets.json', chunk: 0, text: 'SECRET-WORKER-1', vector: new Array(384).fill(0) },
  ] }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'activate_folder', { folder: project });
  const status = await untilReady(worker, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));

  const index = join(project, '.openagent', 'index');
  const raw = JSON.parse(await readFile(join(index, 'codebase.json'), 'utf8'));
  assert.deepEqual([...new Set(raw.entries.map((e: any) => e.file))], ['a.py']);
  assert.deepEqual((await readdir(index)).sort(), ['.gitignore', 'codebase.json'], 'no backup copy of the old index is kept');
});

test('a committed clean git repo stays clean once its activation indexing is ready: git-status answers dirty: false', { timeout: 60000 }, async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-git-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const git = (...args: string[]) => run('git', args, { cwd: project, env: { ...process.env, LC_ALL: 'C' } });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');
  await git('add', 'a.py');
  await git('commit', '-m', 'initial');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  const { folder } = await callWorker(worker, 'activate_folder', { folder: project });
  const status = await untilReady(worker, folder);
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(await callWorker(worker, 'git-status', { folder }), { branch: 'main', dirty: false });
});

// ── lever indexDuringTurns (Task 13): 'pause' holds the indexing while a turn runs ──────────────────────────────

/** A fake model on 127.0.0.1 whose answers are held until release() (and given at once after it): the turn stays open
 * as long as the test wants. */
async function heldModel(t: { after(fn: () => unknown): void }) {
  const held: Array<{ response: ServerResponse; answer: () => void }> = [];
  let released = false;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer = () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })); };
      if (released) answer(); else held.push({ response, answer });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const h of held) h.response.destroy(); server.closeAllConnections?.(); server.close(() => resolve(undefined)); }));
  return {
    testModel: { base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'm' },
    release: () => { released = true; for (const h of held.splice(0)) h.answer(); },
  };
}

/**
 * A worker with the lever indexDuringTurns 'pause', a project of 60 files (two or three chunks each) activated, and a
 * send made once the indexing has really started (its first progress event: never true before the activation). Every
 * worker message is kept in order, `sentAt` marking where the send's reply arrived.
 */
async function turnDuringIndexing(t: any, name: string) {
  // Registered first, so it runs before removeAtEnd's terminate(): a failed assertion can leave the indexing inside an
  // ONNX run, and ending the thread there crashes the whole test process (worker.mjs, shutdownWorker). The shutdown op
  // stops the turn and the indexing and waits for them; the thread then ends itself.
  let worker: Worker | null = null;
  t.after(async () => {
    if (!worker) return;
    const exited = new Promise(resolve => worker!.once('exit', resolve));
    worker.postMessage({ id: 'shutdown-at-end', op: 'shutdown', payload: {} });
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 60000))]);
  });
  const root = await mkdtemp(join(tmpdir(), `openagent-worker-index-${name}-`));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  for (let i = 0; i < 60; i++) {
    const text = Array.from({ length: 30 }, (_, line) => `Fichier ${i}, ligne ${line} : une phrase pour remplir les morceaux de l'index.`).join('\n');
    await writeFile(join(project, `f${String(i).padStart(2, '0')}.md`), text);
  }
  const model = await heldModel(t);
  worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, [PERF_LEVERS_ENV]: JSON.stringify({ indexDuringTurns: 'pause' }) },
    workerData: { testProviderModule: TEST_PROVIDER_MODULE, perfLeversAllowed: true },
  });
  terminateAtEnd(t, worker);
  const messages: any[] = [];
  const waiters: Array<() => void> = [];
  worker.on('message', message => { messages.push(message); for (const wake of waiters.splice(0)) wake(); });
  /** Resolves with the index of the first message from `from` on that `match`es, waiting for it at most `ms`. */
  const until = async (match: (message: any) => boolean, from: number, ms: number): Promise<number> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const at = messages.findIndex((message, i) => i >= from && match(message));
      if (at >= 0) return at;
      if (Date.now() > deadline) throw new Error(`timed out; last messages: ${JSON.stringify(messages.slice(-3))}`);
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  const { folder } = await callWorker(worker, 'activate_folder', { folder: project });
  const isIndex = (message: any) => message?.type === 'event' && message.event === 'index' && message.folder === folder;
  await until(message => isIndex(message) && message.state === 'indexing' && message.current >= 1, 0, 30000);
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'salut', testModel: model.testModel });
  const sentAt = messages.findIndex(message => message?.ok === true && message.result?.runId === runId) + 1;
  assert.ok(sentAt > 0);
  const atSend = await callWorker(worker, 'index-status', { folder });
  assert.equal(atSend.state, 'indexing', `the indexing is still running when the turn starts: ${JSON.stringify(atSend)}`);
  assert.ok(atSend.current < atSend.total, JSON.stringify(atSend));
  // The turn is held open (its model call unanswered) for a while: long enough for several files to be indexed.
  await new Promise(resolve => setTimeout(resolve, 1500));
  return { worker, folder, runId, model, messages, sentAt, until, isIndex };
}

test('a send pauses the indexing until the turn ends (lever indexDuringTurns: pause)', { timeout: 90000 }, async t => {
  const { worker, folder, runId, model, messages, sentAt, until, isIndex } = await turnDuringIndexing(t, 'pause');
  assert.equal((await callWorker(worker, 'index-status', { folder })).state, 'indexing', 'still indexing, held while the turn runs');
  model.release();
  const doneAt = await until(message => message?.event === 'agent' && message.runId === runId && message.kind === 'done', sentAt, 30000);
  assert.deepEqual(messages.slice(sentAt, doneAt).filter(isIndex), [], 'no index event between send-started and done');
  const readyAt = await until(message => isIndex(message) && message.state === 'ready', sentAt, 60000);
  assert.ok(readyAt > doneAt, 'ready only after done');
  assert.ok(messages.slice(doneAt, readyAt).some(message => isIndex(message) && message.state === 'indexing'), 'the indexing went on after the turn');
});

test('a stopped turn resumes the indexing (lever indexDuringTurns: pause)', { timeout: 90000 }, async t => {
  const { worker, runId, messages, sentAt, until, isIndex } = await turnDuringIndexing(t, 'stop');
  await callWorker(worker, 'stop', { runId });
  const stoppedAt = await until(message => message?.event === 'agent' && message.runId === runId && message.kind === 'stopped', sentAt, 30000);
  assert.deepEqual(messages.slice(sentAt, stoppedAt).filter(isIndex), [], 'no index event between send-started and stopped');
  const readyAt = await until(message => isIndex(message) && message.state === 'ready', stoppedAt, 60000);
  assert.ok(readyAt > stoppedAt);
});
