import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point: as a library, its helpers run.
// Every call below passes an explicit temporary user home: the real ~/.openagent is never read.
const { resolveMainDataHome, startupFailure } = createRequire(import.meta.url)('../main.cjs');
const { resolveHomes } = createRequire(import.meta.url)('../core/data-home.cjs');

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `main-home-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('main follows ~/.openagent/redirect.json like the worker, and stays in ~/.openagent without one', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-redirect-'));
  removeAtEnd(t, userHome);
  const defaultHome = join(userHome, '.openagent');
  await mkdir(defaultHome);
  assert.equal(await resolveMainDataHome({}, userHome), defaultHome);
  const moved = join(userHome, 'ailleurs');
  await writeFile(join(defaultHome, 'redirect.json'), JSON.stringify({ data_dir: moved }));
  assert.equal(await resolveMainDataHome({}, userHome), moved);
});

test('OPENAGENT_HOME (tests only) takes the place of ~/.openagent — its own redirect.json is followed, never the real one', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-env-'));
  removeAtEnd(t, userHome);
  const isolated = join(userHome, 'isolated');
  await mkdir(isolated);
  // A redirect in the (temporary) ~/.openagent is ignored: OPENAGENT_HOME replaces that whole location.
  await mkdir(join(userHome, '.openagent'));
  await writeFile(join(userHome, '.openagent', 'redirect.json'), JSON.stringify({ data_dir: join(userHome, 'jamais') }));
  assert.equal(await resolveMainDataHome({ OPENAGENT_HOME: isolated }, userHome), isolated);
  const redirected = join(userHome, 'redirige');
  await writeFile(join(isolated, 'redirect.json'), JSON.stringify({ data_dir: redirected }));
  assert.equal(await resolveMainDataHome({ OPENAGENT_HOME: isolated }, userHome), redirected);
});

test('the worker resolves its data home through the same module: under OPENAGENT_HOME with a redirect, it writes into the redirected folder, where main looks', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-main-home-worker-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const redirected = join(root, 'redirige');
  await Promise.all([mkdir(home), mkdir(redirected)]);
  await writeFile(join(home, 'redirect.json'), JSON.stringify({ data_dir: redirected }));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { theme: 'light' } });
  assert.equal(JSON.parse(await readFile(join(redirected, 'config.json'), 'utf8')).theme, 'light', 'the worker wrote in the redirected folder');
  await assert.rejects(readFile(join(home, 'config.json')), /ENOENT/, 'and nothing in the home that only holds the pointer');
  assert.equal(await resolveMainDataHome({ OPENAGENT_HOME: home }, root), redirected, 'main resolves the very same folder');
});

test('a corrupt redirect.json, or a directory in its place, is an error that names the file — never a silent fallback to the default home', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-bad-redirect-'));
  removeAtEnd(t, userHome);
  const home = join(userHome, 'home');
  const file = join(home, 'redirect.json');
  await mkdir(home);
  await writeFile(file, '{"data_dir": "coupé au milieu');
  const corrupt = await resolveHomes({ OPENAGENT_HOME: home }, userHome).then(() => null, (e: any) => e);
  assert.ok(corrupt, 'corrupt JSON is refused');
  assert.ok(corrupt.message.includes(file), corrupt.message);
  assert.equal(corrupt.redirectFile, file, 'the error carries the file to fix');
  await rm(file);
  await mkdir(file);
  const directory = await resolveHomes({ OPENAGENT_HOME: home }, userHome).then(() => null, (e: any) => e);
  assert.ok(directory, 'a directory named redirect.json is refused');
  assert.equal(directory.message, `Fichier de données non régulier : ${file}`);
  assert.equal(directory.redirectFile, file);
});

test('a startup that fails on redirect.json tells the user which file to fix; any other startup failure says so plainly', () => {
  const file = join(tmpdir(), 'x', 'redirect.json');
  const error = Object.assign(new Error(`JSON illisible : ${file}. Le fichier est conservé.`), { redirectFile: file });
  assert.deepEqual(startupFailure(error), {
    title: 'openagent — dossier de données illisible',
    message: `JSON illisible : ${file}. Le fichier est conservé.

Corrige ou supprime ${file}, puis relance openagent.`,
  });
  assert.deepEqual(startupFailure(new Error('boom')), { title: 'openagent — démarrage impossible', message: 'boom' });
});
