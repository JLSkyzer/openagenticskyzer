import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const main = require('../main.cjs');

// Answered by main.cjs itself (native dialogs, the opener, artifacts, updates), before the allow-list.
const HANDLED_BY_MAIN = ['open-folder', 'open-export', 'artifact-put', 'pick-gguf', 'pick-data-dir', 'pick-knowledge-file', 'update-status', 'update-check', 'update-install-now', 'restart-app'];

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

test('main folds nothing into a payload: no connection resolution is left', () => {
  assert.equal(main.resolveSendPayload, undefined); assert.equal(main.needsConnection, undefined);
  assert.equal(main.isBackendOp('model-status'), true);
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
