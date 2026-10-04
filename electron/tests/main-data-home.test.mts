import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point: as a library, its helpers run.
// Every call below passes an explicit temporary user home: the real ~/.openagent is never read.
const { resolveMainDataHome, createConnections } = createRequire(import.meta.url)('../main.cjs');

// Real authenticated encryption in place of the OS safeStorage, as in connections.test.mts.
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
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

test('R4: after a real migrate-data-dir, the vault main.cjs::createConnections opens is in the new folder, with its key', { timeout: 30000 }, async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-vault-'));
  removeAtEnd(t, userHome);
  const defaultHome = join(userHome, '.openagent');
  const newDir = join(userHome, 'donnees-deplacees');
  await mkdir(join(defaultHome, 'knowledge'), { recursive: true });
  await writeFile(join(defaultHome, 'knowledge', 'store.json'), '{"chunks":[]}');
  const cipher = encryption();
  // The exact function main.cjs calls at startup — only the user home, the environment and the cipher are the test's.
  const before = await createConnections({ env: {}, userHome, cipher });
  await before.save(null, { provider: 'openrouter', model: 'm', api_key: 'sk-VAULT-FOLLOWS' });
  assert.ok((await readFile(join(defaultHome, 'connections.v1.json'))).length > 0, 'the vault starts in ~/.openagent');

  // The worker's data home IS the temporary default home: OPENAGENT_HOME keeps it off the real ~/.openagent.
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: defaultHome } }));
  const result = await callWorker(worker, 'migrate-data-dir', { newDir });
  assert.deepEqual(result.errors, []);

  // The next start of the main process.
  const after = await createConnections({ env: {}, userHome, cipher });
  assert.equal((await after.resolve(null)).api_key, 'sk-VAULT-FOLLOWS', 'the vault followed the data');
  assert.ok((await readFile(join(newDir, 'connections.v1.json'))).length > 0, 'it is read from the new folder');
  await assert.rejects(readFile(join(defaultHome, 'connections.v1.json')), /ENOENT/, 'nothing left in the old folder');
  assert.equal(await readFile(join(newDir, 'knowledge', 'store.json'), 'utf8'), '{"chunks":[]}', 'sub-folders followed too');
});
