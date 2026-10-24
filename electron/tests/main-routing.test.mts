import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnLogDir } from '../core/turn-log.mts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const main = require('../main.cjs');

// Answered by main.cjs itself (native dialogs, the opener, artifacts, updates), before the allow-list.
const HANDLED_BY_MAIN = ['open-folder', 'open-export', 'artifact-put', 'pick-gguf', 'pick-data-dir', 'pick-knowledge-file', 'update-status', 'update-check', 'update-install-now', 'restart-app', 'open-turn-logs'];

test('every operation the renderer bridge calls is known to main.cjs', async () => {
  // A new bridge function whose op was forgotten in main.cjs only fails at runtime, with "Opération IPC
  // inconnue" — as it would have for `compact`. Reading bridge.ts keeps that from being possible.
  const source = await readFile(fileURLToPath(new URL('../renderer-src/src/ipc/bridge.ts', import.meta.url)), 'utf8');
  const ops = [...source.matchAll(/\brequest(?:<[^>(]*>)?\('([a-z_-]+)'/g)].map(match => match[1]);
  // Proves the extraction itself works (an empty list would make this test pass for nothing).
  for (const known of ['send', 'fork', 'messages', 'model-status']) assert.ok(ops.includes(known), `the bridge scan found "${known}"`);
  const unknown = ops.filter(op => !HANDLED_BY_MAIN.includes(op) && !main.isBackendOp(op));
  assert.deepEqual(unknown, [], 'operations called by the renderer but refused by main.cjs');
});

test('restart-app (« Redémarrer maintenant » after a data-folder migration) is called by the bridge and answered by main.cjs itself, never forwarded to the worker', async () => {
  const source = await readFile(fileURLToPath(new URL('../renderer-src/src/ipc/bridge.ts', import.meta.url)), 'utf8');
  assert.match(source, /\brequest(?:<[^>(]*>)?\('restart-app'/, 'the bridge calls it');
  assert.equal(main.isBackendOp('restart-app'), false, 'the worker never receives it: the main process restarts the app');
  const mainSource = await readFile(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  assert.match(mainSource, /request\.op === 'restart-app'\) return restartApp\(\)/, 'main.cjs answers it with restartApp()');
  assert.equal(typeof main.restartApp, 'function');
});

test('open-turn-logs is answered by main: it creates logs/turns and opens exactly that folder', async t => {
  assert.equal(main.isBackendOp('open-turn-logs'), false, 'the worker never receives it');
  const mainSource = await readFile(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  assert.match(mainSource, /request\.op === 'open-turn-logs'\) return openTurnLogs\(startupDataHome, [^\n]*\(\) => resolveMainDataHome\(\)\)/, 'main.cjs answers it before the allow-list, checking the data home is still the one it started with');
  const home = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Never the real shell.openPath: it would open Explorer on the machine running the tests.
  const opened: string[] = [];
  const result = await main.openTurnLogs(home, async (target: string) => { opened.push(target); return ''; }, async () => home);
  assert.deepEqual(opened, [join(home, 'logs', 'turns')]);
  assert.equal(opened[0], turnLogDir(home), 'the folder core/turn-log.mts writes into');
  assert.ok((await stat(opened[0])).isDirectory());
  assert.deepEqual(result, { opened: true, dir: turnLogDir(home) });
});

test('open-turn-logs reports the opener\'s error', async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-error-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(main.openTurnLogs(home, async () => 'Accès refusé', async () => home), { message: 'Accès refusé' });
});

test('open-turn-logs never opens nor creates through a linked logs folder', async t => {
  // core/turn-log.mts writes only into real folders; a junction planted as logs/ could point anywhere.
  const home = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-link-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-target-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(elsewhere, { recursive: true, force: true })]));
  await symlink(elsewhere, join(home, 'logs'), 'junction');
  const opened: string[] = [];
  await assert.rejects(main.openTurnLogs(home, async (target: string) => { opened.push(target); return ''; }, async () => home), /n'est pas un vrai dossier/);
  assert.deepEqual(opened, [], 'nothing is opened');
  assert.equal(existsSync(join(elsewhere, 'turns')), false, 'nothing is created behind the link');
});

test('open-turn-logs checks the folder with the turn log writer’s own function, defined once (M-e)', async () => {
  const mainSource = await readFile(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  const turnLogSource = await readFile(new URL('../core/turn-log.mts', import.meta.url), 'utf8');
  assert.match(mainSource, /require\('\.\/core\/log-dir\.cjs'\)/);
  assert.match(mainSource, /realLogDir\(dataHome, \{ create: true \}\)/);
  assert.match(turnLogSource, /import \{ realLogDir \} from '\.\/log-dir\.cjs';/);
  assert.doesNotMatch(turnLogSource, /function realLogDir/, 'not duplicated');
});

test('open-turn-logs after a data-folder migration (redirect written after the start) refuses and creates nothing', async t => {
  // The start-up home is the default one; a migration then leaves only redirect.json there until the restart
  // (core/data-dir.mts). Recreating logs/turns in it would make a later migration back to it refuse (« contient déjà »).
  const startupHome = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-moved-'));
  const movedTo = await mkdtemp(join(tmpdir(), 'openagent-open-turn-logs-new-home-'));
  t.after(() => Promise.all([rm(startupHome, { recursive: true, force: true }), rm(movedTo, { recursive: true, force: true })]));
  const env = { OPENAGENT_HOME: startupHome };
  assert.equal(await main.resolveMainDataHome(env), startupHome, 'before the migration, the start-up home is the data home');
  await writeFile(join(startupHome, 'redirect.json'), JSON.stringify({ data_dir: movedTo }));
  const opened: string[] = [];
  await assert.rejects(
    main.openTurnLogs(startupHome, async (target: string) => { opened.push(target); return ''; }, () => main.resolveMainDataHome(env)),
    { message: 'Le dossier de données a été déplacé : redémarrez l\'app pour ouvrir ses journaux.' },
  );
  assert.deepEqual(opened, [], 'nothing is opened');
  assert.deepEqual(await readdir(startupHome), ['redirect.json'], 'the old home still holds only redirect.json');
  assert.deepEqual(await readdir(movedTo), [], 'nothing is created in the new home before the restart');
});

test('main folds nothing into a payload: no connection resolution is left', () => {
  assert.equal(main.resolveSendPayload, undefined); assert.equal(main.needsConnection, undefined);
  assert.equal(main.isBackendOp('model-status'), true);
  assert.equal(main.isBackendOp('hardware-info'), true);
  assert.equal(main.isBackendOp('estimate-model'), true);
  assert.equal(main.isBackendOp('estimate-cancel'), true);
  for (const op of ['cuda-pack-status', 'cuda-pack-install', 'cuda-pack-cancel', 'cuda-pack-uninstall']) assert.equal(main.isBackendOp(op), true, op);
});

test('main no longer answers any connection op', async () => {
  // handleBackendRequest cannot be called without the real window (its sender check throws first): the sources are read.
  const mainSource = await readFile(fileURLToPath(new URL('../main.cjs', import.meta.url)), 'utf8');
  for (const op of ['connection-snapshot', 'save-connection']) {
    assert.equal(mainSource.includes(`'${op}'`), false, `main.cjs still names ${op}`);
    assert.equal(main.isBackendOp(op), false);
  }
  const source = await readFile(fileURLToPath(new URL('../renderer-src/src/ipc/bridge.ts', import.meta.url)), 'utf8');
  const ops = [...source.matchAll(/\brequest(?:<[^>(]*>)?\('([a-z_-]+)'/g)].map(match => match[1]);
  assert.ok(ops.includes('model-status'), 'the bridge scan works');
  assert.deepEqual(ops.filter(op => op === 'connection-snapshot' || op === 'save-connection'), [], 'the bridge calls no connection op');
  assert.equal(main.createConnections, undefined, 'no vault is opened at startup');
});

test('isExportFilename accepts exactly the pattern the exporter itself generates, nothing else', () => {
  assert.equal(main.isExportFilename('conversation_20260923_090503.md'), true);
  assert.equal(main.isExportFilename('conversation_20260923_090503.html'), true);
  assert.equal(main.isExportFilename('conversation_20260923_090503.json'), true);
  assert.equal(main.isExportFilename('conversation_20260923_090503.exe'), false, 'wrong extension');
  assert.equal(main.isExportFilename('../../etc/passwd'), false);
  assert.equal(main.isExportFilename('conversation_2026923_090503.md'), false, 'wrong digit count');
  assert.equal(main.isExportFilename('other.md'), false);
  assert.equal(main.isExportFilename(''), false);
  assert.equal(main.isExportFilename('conversation_20260923_090503.md/../secret'), false, 'no trailing garbage after the extension');
});

test('internal and unknown operations are not reachable from the page', () => {
  assert.equal(main.isBackendOp('shutdown'), false, 'shutdown is sent by main.cjs itself');
  assert.equal(main.isBackendOp('nope'), false);
  assert.equal(main.isBackendOp('compact'), true);
});

test('notificationBodyFor prefers the summary on a real completion, and the error on a failure', () => {
  assert.equal(main.notificationBodyFor({ kind: 'done', summary: 'Fichier créé.' }), 'Fichier créé.');
  assert.equal(main.notificationBodyFor({ kind: 'done' }), 'Tâche terminée', 'no summary at all falls back');
  assert.equal(main.notificationBodyFor({ kind: 'error', message: 'Connexion refusée' }), 'Erreur : Connexion refusée');
});

test('notificationBodyFor caps the body at 200 characters, like the old notifier.py did', () => {
  const body = main.notificationBodyFor({ kind: 'done', summary: 'x'.repeat(500) });
  assert.equal(body.length, 200);
});
