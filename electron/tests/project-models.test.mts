// A model per project (catalogue Task 6): the choice is kept in the user's data (<home>/project-models.json), keyed by
// the folder's canonical path like the folders list, never in the project. A repository from the internet cannot
// impose a model: its .openagent/config.json is never read for it. Every home is a mkdtemp folder; the only model a
// turn loads is the stories260K fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectModels } from '../core/project-models.mts';
import { activeModel, turnModelStatus, LOCAL_MODEL_MISSING, PROJECT_MODEL_FALLBACK } from '../core/active-model.mts';
import { SettingsService } from '../core/settings.mts';
import { GgufLibrary } from '../core/gguf-library.mts';
import { callWorker } from './support/worker-events.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const STORIES = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

type T = { after(fn: () => unknown): void; diagnostic?(message: string): void };

/** Every file under `dir` with its size and modification time: equal snapshots mean nothing was written there. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { out.push(`${path}/`); await walk(path); }
      else { const info = await stat(path); out.push(`${path} ${info.size} ${info.mtimeMs}`); }
    }
  }
  await walk(dir);
  return out.sort();
}

/** A data home, two projects (A holds a hostile .openagent/config.json) and two copies of stories260K in a library. */
async function setup(t: T) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-project-models-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const projectA = join(root, 'projet-a');
  const projectB = join(root, 'projet-b');
  await Promise.all([mkdir(home), mkdir(join(projectA, '.openagent'), { recursive: true }), mkdir(projectB)]);
  const one = join(root, 'un.gguf');
  const two = join(root, 'deux.gguf');
  await Promise.all([copyFile(STORIES, one), copyFile(STORIES, two)]);
  const settings = new SettingsService(home);
  const library = new GgufLibrary(home);
  const first = await library.add(one);
  const second = await library.add(two);
  return { root, home, projectA, projectB, one, two, settings, library, first, second };
}

test('ProjectModels: no choice is null; a choice is read back under any spelling of the folder; null clears it', async t => {
  const { home, projectA, projectB } = await setup(t);
  const store = new ProjectModels(home);
  assert.equal(await store.get(projectA), null);
  await store.set(projectA, 'model-1');
  assert.equal(await store.get(projectA), 'model-1');
  assert.equal(await store.get(projectA + '\\'), 'model-1');
  if (process.platform === 'win32') assert.equal(await store.get(projectA.toUpperCase()), 'model-1');
  assert.equal(await store.get(projectB), null);
  await store.set(projectA, null);
  assert.equal(await store.get(projectA), null);
  // Kept in the user's data, under the canonical key the folders list uses.
  assert.ok(JSON.parse(await readFile(join(home, 'project-models.json'), 'utf8')));
  await assert.rejects(store.set('relatif', 'model-1'), /absolu/);
  assert.equal(await store.get('relatif'), null);
});

test('ProjectModels writes nothing under the project folder', async t => {
  const { home, projectA, projectB } = await setup(t);
  await writeFile(join(projectA, '.openagent', 'config.json'), JSON.stringify({ agent_mode: 'inherit' }));
  const before = [await snapshot(projectA), await snapshot(projectB)];
  const store = new ProjectModels(home);
  await store.set(projectA, 'model-1');
  await store.set(projectB, 'model-2');
  await store.get(projectA);
  await store.set(projectA, null);
  assert.deepEqual([await snapshot(projectA), await snapshot(projectB)], before);
});

test('activeModel: no project choice answers the global model', async t => {
  const { settings, library, projectA, first } = await setup(t);
  await settings.saveGlobal({ active_local_model: first.id });
  assert.deepEqual(await activeModel(settings, library, projectA), { id: first.id, name: first.name, path: first.path, fallback: false });
  assert.deepEqual(await activeModel(settings, library), { id: first.id, name: first.name, path: first.path, fallback: false });
});

test('activeModel: a project choice answers that model, and only in that project', async t => {
  const { home, settings, library, projectA, projectB, first, second } = await setup(t);
  await settings.saveGlobal({ active_local_model: first.id });
  await new ProjectModels(home).set(projectA, second.id);
  assert.deepEqual(await activeModel(settings, library, projectA), { id: second.id, name: second.name, path: second.path, fallback: false });
  assert.equal((await activeModel(settings, library, projectB))?.id, first.id);
  // A project choice also answers when no global model is set.
  await settings.saveGlobal({ active_local_model: '' });
  assert.equal((await activeModel(settings, library, projectA))?.path, second.path);
});

test('activeModel: the project model\'s file gone, the default answers with fallback: true and the notice', async t => {
  const { home, settings, library, projectA, first, second, two } = await setup(t);
  await settings.saveGlobal({ active_local_model: first.id });
  await new ProjectModels(home).set(projectA, second.id);
  await rm(two);
  const model = await activeModel(settings, library, projectA);
  assert.deepEqual(model, { id: first.id, name: first.name, path: first.path, fallback: true });
  const status = turnModelStatus(model);
  assert.equal(status.fallback, true);
  assert.equal(status.notice, 'Le modèle de ce projet est introuvable : modèle par défaut utilisé.');
  assert.equal(PROJECT_MODEL_FALLBACK, 'Le modèle de ce projet est introuvable : modèle par défaut utilisé.');
  // A model that is not a fallback says nothing of the kind.
  const plain = turnModelStatus({ ...model!, fallback: false });
  assert.equal('fallback' in plain, false);
  assert.equal('notice' in plain, false);
  // Gone too, with no default to answer: refused, as a missing model always is.
  await settings.saveGlobal({ active_local_model: '' });
  await assert.rejects(activeModel(settings, library, projectA), { message: LOCAL_MODEL_MISSING });
});

test('activeModel: a project .openagent/config.json naming active_local_model or project_model has no effect', async t => {
  const { settings, library, projectA, first, second } = await setup(t);
  await writeFile(join(projectA, '.openagent', 'config.json'), JSON.stringify({ active_local_model: second.id, project_model: second.id }));
  await settings.saveGlobal({ active_local_model: first.id });
  assert.equal((await activeModel(settings, library, projectA))?.id, first.id);
  // Without a global model, the repository still imposes nothing.
  await settings.saveGlobal({ active_local_model: '' });
  assert.equal(await activeModel(settings, library, projectA), null);
});

test('activeModel: a model resolved for project A stays when project B\'s choice changes', async t => {
  const { home, settings, library, projectA, projectB, first, second } = await setup(t);
  await settings.saveGlobal({ active_local_model: first.id });
  const store = new ProjectModels(home);
  await store.set(projectA, second.id);
  const before = await activeModel(settings, library, projectA);
  await store.set(projectB, first.id);
  await store.set(projectB, null);
  assert.deepEqual(await activeModel(settings, library, projectA), before);
});

// ---------------------------------------------------------------------------------------------------------------
// Through the worker: the ops, and the model a real turn runs on (stories260K, stopped as soon as it has loaded).

/** Sends one message in `folder`; resolves with its 'model' event, then stops the run and waits for its end.
 * `meanwhile` runs once the send has answered, before the model event is awaited. */
async function turnModel(worker: Worker, folder: string, meanwhile: () => Promise<void> = async () => {}): Promise<any> {
  const events: any[] = [];
  const ends = new Map<string, any>();
  const listener = (message: any) => {
    if (message?.type !== 'event') return;
    if (message.event === 'model') events.push(message);
    if (message.event === 'agent' && ['done', 'error', 'stopped'].includes(message.kind)) ends.set(message.runId, message);
  };
  worker.on('message', listener);
  try {
    const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
    await meanwhile();
    while (!events.length && !ends.has(runId)) await new Promise(resolve => setTimeout(resolve, 20));
    if (!ends.has(runId)) await callWorker(worker, 'stop', { runId });
    while (!ends.has(runId)) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.length, `no model event: ${JSON.stringify(ends.get(runId))}`);
    return events[0];
  } finally {
    worker.off('message', listener);
  }
}

async function workerSetup(t: T) {
  const base = await setup(t);
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: base.home } });
  terminateAtEnd(t, worker);
  return { ...base, worker };
}

test('worker: project-model-get/set keep the choice in the user\'s data and touch nothing in the project', { timeout: 30000 }, async t => {
  const { worker, home, projectA, second } = await workerSetup(t);
  const before = await snapshot(projectA);
  assert.equal(await callWorker(worker, 'project-model-get', { folder: projectA }), null);
  assert.equal(await callWorker(worker, 'project-model-set', { folder: projectA, modelId: second.id }), second.id);
  assert.equal(await callWorker(worker, 'project-model-get', { folder: projectA }), second.id);
  assert.equal(await new ProjectModels(home).get(projectA), second.id);
  // A model the library does not hold is refused, the choice unchanged.
  await assert.rejects(callWorker(worker, 'project-model-set', { folder: projectA, modelId: 'inconnu' }), { message: LOCAL_MODEL_MISSING });
  assert.equal(await callWorker(worker, 'project-model-get', { folder: projectA }), second.id);
  assert.equal(await callWorker(worker, 'project-model-set', { folder: projectA, modelId: null }), null);
  assert.deepEqual(await snapshot(projectA), before);
});

test('worker: a turn runs on the project\'s model, keeps it when choices change, and falls back with the notice', { timeout: 300000 }, async t => {
  const { worker, root, library, projectA, projectB, first, second } = await workerSetup(t);
  // A third copy, never loaded: a file a loaded engine maps cannot be deleted under Windows.
  const three = join(root, 'trois.gguf');
  await copyFile(STORIES, three);
  const third = await library.add(three);
  await mkdir(join(projectB, '.openagent'));
  await writeFile(join(projectB, '.openagent', 'config.json'), JSON.stringify({ active_local_model: second.id, project_model: second.id }));
  await callWorker(worker, 'save-global-settings', { patch: { active_local_model: first.id } });
  // No choice, a hostile project config: the global model.
  const plain = await turnModel(worker, projectB);
  assert.equal(plain.id, first.id);
  assert.equal(plain.fallback, undefined);
  // A choice: that model, and it stays for the running turn while B's choice and A's own change.
  await callWorker(worker, 'project-model-set', { folder: projectA, modelId: second.id });
  const chosen = await turnModel(worker, projectA, async () => {
    await callWorker(worker, 'project-model-set', { folder: projectB, modelId: second.id });
    await callWorker(worker, 'project-model-set', { folder: projectA, modelId: first.id });
  });
  assert.equal(chosen.id, second.id);
  assert.equal(chosen.name, 'deux.gguf');
  // B's own choice, its file gone: the default answers and says so.
  await callWorker(worker, 'project-model-set', { folder: projectB, modelId: third.id });
  await rm(three);
  const fallback = await turnModel(worker, projectB);
  assert.equal(fallback.id, first.id);
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.notice, PROJECT_MODEL_FALLBACK);
});
