import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPerfLevers, leversInEffect, SHIPPED_LEVERS, PERF_LEVERS_ENV } from '../core/perf-levers.mts';
import { LOCAL_OUTPUT_CAP } from '../core/local-engine.mts';

test('perfLevers: no variable = the shipped levers (today\'s behaviour); a valid key overrides; anything else is rejected and named', () => {
  assert.deepEqual(readPerfLevers({}), { levers: SHIPPED_LEVERS, rejected: [] });
  assert.equal(SHIPPED_LEVERS.outputCap, LOCAL_OUTPUT_CAP);
  assert.equal(SHIPPED_LEVERS.thoughtTokens, null);
  const { levers, rejected } = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ outputCap: 64, nope: 1, thoughtTokens: -3 }) });
  assert.equal(levers.outputCap, 64);
  assert.equal(levers.thoughtTokens, null);
  assert.deepEqual(rejected, ['clé inconnue : nope', 'valeur invalide : thoughtTokens']);
  assert.deepEqual(readPerfLevers({ [PERF_LEVERS_ENV]: '{' }).rejected, ['JSON invalide']);
  // Ruling F6: the switchboard is a bench tool. Where it is not allowed (the packaged app), the variable is ignored and
  // said once; where it is, every lever away from its shipped value is said once.
  const env = { [PERF_LEVERS_ENV]: JSON.stringify({ outputCap: 64 }) };
  assert.deepEqual(leversInEffect(env, false), { levers: SHIPPED_LEVERS, notices: [`[levers] ${PERF_LEVERS_ENV} ignoré : réservé au banc d'essai, hors application empaquetée`] });
  assert.deepEqual(leversInEffect({}, false), { levers: SHIPPED_LEVERS, notices: [] });
  assert.deepEqual(leversInEffect(env, true), { levers: { ...SHIPPED_LEVERS, outputCap: 64 }, notices: ['[levers] actifs : outputCap=64'] });
  assert.deepEqual(leversInEffect({}, true), { levers: SHIPPED_LEVERS, notices: [] });
  // contextPlacement (Task 4, F19): shipped 'system'; 'after-tools' accepted; any other value rejected.
  assert.equal(SHIPPED_LEVERS.contextPlacement, 'system');
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ contextPlacement: 'after-tools' }) }).levers.contextPlacement, 'after-tools');
  const placement = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ contextPlacement: 'après' }) });
  assert.deepEqual([placement.levers.contextPlacement, placement.rejected], ['system', ['valeur invalide : contextPlacement']]);
  // keepThought (Task 5, F19): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.keepThought, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ keepThought: true }) }).levers.keepThought, true);
  const thought = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ keepThought: 'oui' }) });
  assert.deepEqual([thought.levers.keepThought, thought.rejected], [false, ['valeur invalide : keepThought']]);
  // slimToolDefinitions (Task 6, F19, ruling F4): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.slimToolDefinitions, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ slimToolDefinitions: true }) }).levers.slimToolDefinitions, true);
  const slim = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ slimToolDefinitions: 1 }) });
  assert.deepEqual([slim.levers.slimToolDefinitions, slim.rejected], [false, ['valeur invalide : slimToolDefinitions']]);
});

test('the checkpoint levers: shipped at node-llama-cpp\'s defaults; a shorter interval needs a memory cap', () => {
  assert.deepEqual([SHIPPED_LEVERS.checkpointInterval, SHIPPED_LEVERS.checkpointMax, SHIPPED_LEVERS.checkpointMaxMemory], [8192, 32, null]);
  const ok = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointInterval: 1024, checkpointMaxMemory: 1610612736 }) });
  assert.deepEqual([ok.levers.checkpointInterval, ok.rejected], [1024, []]);
  const bad = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointInterval: 1024 }) });
  assert.deepEqual([bad.levers.checkpointInterval, bad.rejected], [8192, ['valeur invalide : checkpointInterval sans checkpointMaxMemory']]);
  // Ruling F19: each key's parsing, one valid and one rejected value.
  const more = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointMax: 8, checkpointMaxMemory: 1 << 30 }) });
  assert.deepEqual([more.levers.checkpointMax, more.levers.checkpointMaxMemory, more.rejected], [8, 1 << 30, []]);
  const wrong = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointInterval: 0, checkpointMax: 1.5, checkpointMaxMemory: -1 }) });
  assert.deepEqual([wrong.levers.checkpointInterval, wrong.levers.checkpointMax, wrong.levers.checkpointMaxMemory], [8192, 32, null]);
  assert.deepEqual(wrong.rejected, ['valeur invalide : checkpointInterval', 'valeur invalide : checkpointMax', 'valeur invalide : checkpointMaxMemory']);
});

test('the promptCheckpoint lever (Task 3b): shipped off; a boolean only', () => {
  assert.equal(SHIPPED_LEVERS.promptCheckpoint, false);
  assert.deepEqual(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ promptCheckpoint: true }) }), { levers: { ...SHIPPED_LEVERS, promptCheckpoint: true }, rejected: [] });
  const wrong = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ promptCheckpoint: 'oui' }) });
  assert.deepEqual([wrong.levers.promptCheckpoint, wrong.rejected], [false, ['valeur invalide : promptCheckpoint']]);
});
