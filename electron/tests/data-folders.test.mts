// The data folder explains itself (core/data-folders.mts): knowledge/, tools/ and logs/ are created at the worker's
// start when missing — nothing that exists is touched — and LISEZMOI.txt, the one file the app owns there, is
// rewritten at each start. Réglages › Général offers the turn log's three levels (general-view.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { callWorker } from './support/worker-events.mts';
import { DATA_FOLDERS, DATA_HOME_ENTRIES, README_FILE, README_TEXT, ensureDataFolders, writeReadme } from '../core/data-folders.mts';
import { TURN_LOG_LEVELS } from '../core/turn-log.mts';
import { TURN_LOG_OPTIONS } from '../renderer-src/src/components/settings/general-view.ts';

const WORKER = fileURLToPath(new URL('../worker.mjs', import.meta.url));

async function tempHome(t: { after(fn: () => unknown): void }, prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  removeAtEnd(t, home);
  return home;
}

test('ensureDataFolders creates knowledge, tools and logs when missing, and touches nothing that exists', async t => {
  const home = await tempHome(t, 'openagent-data-folders-');
  await mkdir(join(home, 'knowledge'));
  await writeFile(join(home, 'knowledge', 'knowledge.json'), '{"x":1}');
  await writeFile(join(home, 'config.json'), '{"agent_mode":"ask"}');
  const before = {
    knowledge: await stat(join(home, 'knowledge', 'knowledge.json')),
    config: await stat(join(home, 'config.json')),
  };
  assert.deepEqual([...DATA_FOLDERS], ['knowledge', 'tools', 'logs']);

  assert.deepEqual(await ensureDataFolders(home), ['tools', 'logs']);
  for (const name of DATA_FOLDERS) assert.ok((await stat(join(home, name))).isDirectory(), `${name}/ exists`);
  assert.equal(await readFile(join(home, 'knowledge', 'knowledge.json'), 'utf8'), '{"x":1}');
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '{"agent_mode":"ask"}');
  assert.equal((await stat(join(home, 'knowledge', 'knowledge.json'))).mtimeMs, before.knowledge.mtimeMs);
  assert.equal((await stat(join(home, 'config.json'))).mtimeMs, before.config.mtimeMs);
  assert.deepEqual(await ensureDataFolders(home), [], 'a second call creates nothing');
});

test('ensureDataFolders leaves an entry of that name as it is: a file, a junction, a dangling junction', async t => {
  const home = await tempHome(t, 'openagent-data-folders-planted-');
  const target = await tempHome(t, 'openagent-data-folders-target-');
  const gone = join(target, 'gone');
  await mkdir(gone);
  await writeFile(join(home, 'tools'), 'pas un dossier');
  await symlink(target, join(home, 'logs'), 'junction');
  await symlink(gone, join(home, 'knowledge'), 'junction');
  await rm(gone, { recursive: true });
  const toolsBefore = await stat(join(home, 'tools'));

  assert.deepEqual(await ensureDataFolders(home), [], 'nothing is created');
  assert.ok((await lstat(join(home, 'tools'))).isFile(), 'tools is still the file');
  assert.equal(await readFile(join(home, 'tools'), 'utf8'), 'pas un dossier');
  assert.equal((await stat(join(home, 'tools'))).mtimeMs, toolsBefore.mtimeMs);
  assert.ok((await lstat(join(home, 'logs'))).isSymbolicLink(), 'logs is still the junction');
  assert.deepEqual(await readdir(target), [], 'nothing is created behind the junction');
  assert.ok((await lstat(join(home, 'knowledge'))).isSymbolicLink(), 'knowledge is still the dangling junction');
  assert.equal(existsSync(gone), false, 'the dangling target is not recreated');
  assert.deepEqual((await readdir(home)).sort(), ['knowledge', 'logs', 'tools']);
});

test('LISEZMOI.txt is rewritten at each call and names every entry of the data folder and of a project', async t => {
  const home = await tempHome(t, 'openagent-readme-');
  assert.equal(README_FILE, 'LISEZMOI.txt');
  await writeFile(join(home, README_FILE), 'ancien');
  await writeReadme(home);
  assert.equal(await readFile(join(home, README_FILE), 'utf8'), README_TEXT);
  await writeReadme(home);
  assert.equal(await readFile(join(home, README_FILE), 'utf8'), README_TEXT, 'rewritten again, same text');
  assert.deepEqual((await readdir(home)).sort(), [README_FILE], 'no temp file is left behind');
  assert.ok(DATA_HOME_ENTRIES.length >= 18);
  for (const { name, role } of DATA_HOME_ENTRIES) {
    assert.ok(README_TEXT.includes(name), `the text names ${name}`);
    assert.ok(role.trim().length > 0, `${name} has a role`);
  }
  assert.ok(README_TEXT.includes('régénéré à chaque démarrage'));
  assert.ok(README_TEXT.includes('.mjs'));
});

test('LISEZMOI.txt carries no personal path', () => {
  assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\/|killi/i.test(README_TEXT), false);
});

test('the worker creates the folders and LISEZMOI.txt at start, in the redirected data home only', { timeout: 30000 }, async t => {
  const defaultHome = await tempHome(t, 'openagent-default-home-');
  const dataHome = await tempHome(t, 'openagent-redirected-home-');
  await writeFile(join(defaultHome, 'redirect.json'), JSON.stringify({ data_dir: dataHome }));
  const worker = new Worker(WORKER, { env: { ...process.env, OPENAGENT_HOME: defaultHome } });
  terminateAtEnd(t, worker);
  // The worker answers only once its start-up (cleanup, folders, LISEZMOI.txt) is done: its listener comes last.
  await callWorker(worker, 'global-settings');
  for (const name of DATA_FOLDERS) assert.ok((await stat(join(dataHome, name))).isDirectory(), `${name}/ in the data home`);
  assert.equal(await readFile(join(dataHome, README_FILE), 'utf8'), README_TEXT);
  assert.deepEqual(await readdir(defaultHome), ['redirect.json'], 'the default home is left as it was');
  assert.equal(existsSync(join(defaultHome, README_FILE)), false);
});

test('TURN_LOG_OPTIONS: the three levels of the setting, in order, in French', () => {
  assert.deepEqual(TURN_LOG_OPTIONS.map(option => option.value), [...TURN_LOG_LEVELS]);
  assert.deepEqual(TURN_LOG_OPTIONS.map(option => option.label), ['Complet (défaut)', 'Sans contenu', 'Désactivé']);
});
