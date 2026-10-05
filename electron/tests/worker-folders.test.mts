import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

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

/** Resolves with the first 'index' event that ends the background indexing of `folder` (ready or error). */
function indexingSettled(worker: Worker, folder: string): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message.type !== 'event' || message.event !== 'index' || message.folder !== folder) return;
      if (message.state !== 'ready' && message.state !== 'error') return;
      worker.off('message', listener);
      resolve(message);
    };
    worker.on('message', listener);
  });
}

// timeout: bounds the wait for the background indexing below, like the index-status tests.
test('worker::activate_folder records the folder in history and returns it with the chat history', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-'));
  // Worker terminated before the dir is removed, in one hook: see teardown.mts.
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);

  // OPENAGENT_HOME keeps this test from ever touching the real developer's
  // ~/.openagent — see worker.mjs.
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));

  // activate_folder also starts indexing the folder in the background (it writes
  // project/.openagent/index/codebase.json after replying): wait for it to end, so nothing
  // still writes into the temp dir when the test cleans it up.
  const indexed = indexingSettled(worker, project);
  const activated = await callWorker(worker, 'activate_folder', { folder: project });
  assert.deepEqual(activated.history, []);
  assert.equal(activated.folders.length, 1);
  assert.equal(activated.folders[0].name, 'project');

  const listed = await callWorker(worker, 'list_folders', {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'project');

  assert.equal((await indexed).state, 'ready');
});

test('R3: a history saved by the Python app (roles human/ai) is served as user/assistant, and a read writes nothing', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-legacy-roles-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(join(project, '.openagent'), { recursive: true })]);
  const legacy = JSON.stringify([
    { role: 'human', content: 'question posée à l’ancienne app' },
    { role: 'ai', content: 'réponse de l’ancienne app' },
    { role: 'tool', content: 'sortie' },
  ]);
  await writeFile(join(project, '.openagent', 'chat_history.json'), legacy);

  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  const indexed = indexingSettled(worker, project);
  const activated = await callWorker(worker, 'activate_folder', { folder: project });
  assert.deepEqual(activated.history.map((m: any) => m.role), ['user', 'assistant', 'tool'], 'activation');
  const loaded = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(loaded.map((m: any) => m.role), ['user', 'assistant', 'tool'], 'branch load');
  assert.equal(loaded[1].content, 'réponse de l’ancienne app');
  assert.equal(await readFile(join(project, '.openagent', 'chat_history.json'), 'utf8'), legacy, 'the Python file is not rewritten by a read');
  await assert.rejects(readFile(join(project, '.openagent', 'conversations.json')), /ENOENT/, 'and no new file is written by a read');
  await indexed;
});

test('worker::activate_folder answers the folder under the spelling the history stores, whatever spelling was typed', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-typed-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const canonical = await realpath(project);
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  const indexed = indexingSettled(worker, canonical);
  // Forward slashes and a trailing separator: how a path is often typed or pasted.
  const activated = await callWorker(worker, 'activate_folder', { folder: project.replaceAll('\\', '/') + '/' });
  assert.equal(activated.folder, canonical);
  assert.equal(activated.folders[0].path, canonical, 'the folder the history now lists first');
  await indexed;
});

// F3: the background index is keyed on the canonical folder too — under the typed spelling (another case under
// Windows), its 'index' events and index-status would name a folder the renderer never activates.
test('worker::activate_folder indexes the folder under its canonical path, not under the typed spelling', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-canonical-index-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');
  const canonical = await realpath(project);
  // Windows: another case and forward slashes (one folder for its file system, another string for resolve()).
  // Elsewhere case matters, so only the trailing separator differs (resolve() already drops it).
  const typed = process.platform === 'win32' ? canonical.toUpperCase().replaceAll('\\', '/') : `${canonical}/`;
  // resolve() keeps the case: under Windows the typed spelling must really be another string once resolved.
  if (process.platform === 'win32') assert.notEqual(resolve(typed), canonical, 'the typed spelling differs from the canonical one');
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  // Every 'index' event of this activation, whatever folder it names; the run ends on the first ready/error.
  const events: any[] = [];
  const settled = new Promise<any>(resolve => {
    worker.on('message', (message: any) => {
      if (message.type !== 'event' || message.event !== 'index') return;
      events.push(message);
      if (message.state === 'ready' || message.state === 'error') resolve(message);
    });
  });
  const activated = await callWorker(worker, 'activate_folder', { folder: typed });
  assert.equal(activated.folder, canonical, 'the reply names the canonical folder');
  assert.equal((await settled).state, 'ready');
  assert.ok(events.length >= 2, `indexing then ready: ${JSON.stringify(events)}`);
  assert.deepEqual([...new Set(events.map(event => event.folder))], [canonical], 'every index event names the canonical folder');
  assert.equal((await callWorker(worker, 'index-status', { folder: canonical })).state, 'ready', 'index-status under the canonical folder');
});

// Pins the deduplication activate_folder relies on (core/folders.mts): two spellings of one folder are one entry,
// stored under its canonical path, at the front of the history.
test('worker::activate_folder keeps one history entry for two spellings of the same folder', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-dedup-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  const other = join(root, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  const canonical = await realpath(project);
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  // Windows: another case and forward slashes for the second spelling; elsewhere, a trailing separator.
  const second = process.platform === 'win32' ? canonical.toUpperCase().replaceAll('\\', '/') : `${canonical}/`;
  for (const folder of [canonical, other, second]) {
    const indexed = indexingSettled(worker, await realpath(folder));
    const activated = await callWorker(worker, 'activate_folder', { folder });
    await indexed;
    if (folder === second) {
      assert.equal(activated.folder, canonical);
      assert.deepEqual(activated.folders.map((entry: any) => entry.path), [canonical, await realpath(other)], 'one entry for the folder, at the front, canonical');
    }
  }
  const listed = await callWorker(worker, 'list_folders', {});
  assert.deepEqual(listed.map((entry: any) => entry.path), [canonical, await realpath(other)], 'and on disk');
});
