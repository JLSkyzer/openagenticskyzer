import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPerfLevers, leversInEffect, SHIPPED_LEVERS, PERF_LEVERS_ENV } from '../core/perf-levers.mts';
import { LOCAL_OUTPUT_CAP } from '../core/local-engine.mts';

test('perfLevers: no variable = the shipped levers; a valid key overrides; anything else is rejected and named', () => {
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
  // slimToolDefinitions (Task 6, F19, ruling F4): shipped on (S2); a boolean only.
  assert.equal(SHIPPED_LEVERS.slimToolDefinitions, true);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ slimToolDefinitions: false }) }).levers.slimToolDefinitions, false);
  const slim = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ slimToolDefinitions: 1 }) });
  assert.deepEqual([slim.levers.slimToolDefinitions, slim.rejected], [true, ['valeur invalide : slimToolDefinitions']]);
  // rereadWeighting (Task 12, F19): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.rereadWeighting, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ rereadWeighting: true }) }).levers.rereadWeighting, true);
  const reread = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ rereadWeighting: 'oui' }) });
  assert.deepEqual([reread.levers.rereadWeighting, reread.rejected], [false, ['valeur invalide : rereadWeighting']]);
  // mcpKeepAlive (Task 14, F19): shipped on (S2); a boolean only.
  assert.equal(SHIPPED_LEVERS.mcpKeepAlive, true);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ mcpKeepAlive: false }) }).levers.mcpKeepAlive, false);
  const keepAlive = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ mcpKeepAlive: 'oui' }) });
  assert.deepEqual([keepAlive.levers.mcpKeepAlive, keepAlive.rejected], [true, ['valeur invalide : mcpKeepAlive']]);
});

test('a retired lever is an unknown key: the bench refuses it instead of silently running the shipped value', () => {
  for (const key of ['checkpointInterval', 'checkpointMax', 'contextPlacement', 'keepThought', 'engineAtBoot', 'overlapLoad', 'numericLimitLoad', 'inputLookup', 'batchSize', 'threads', 'kvCacheType', 'indexDuringTurns', 'embedThreads']) {
    assert.deepEqual(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ [key]: 1 }) }), { levers: { ...SHIPPED_LEVERS }, rejected: [`clé inconnue : ${key}`] });
    assert.equal(key in SHIPPED_LEVERS, false, key);
  }
});

test('the checkpoint memory cap: shipped at 1.5 GiB (S2); a positive integer, or null for none', () => {
  assert.equal(SHIPPED_LEVERS.checkpointMaxMemory, 1610612736);
  const set = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointMaxMemory: 1 << 30 }) });
  assert.deepEqual([set.levers.checkpointMaxMemory, set.rejected], [1 << 30, []]);
  const none = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointMaxMemory: null }) });
  assert.deepEqual([none.levers.checkpointMaxMemory, none.rejected], [null, []]);
  const wrong = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointMaxMemory: -1 }) });
  assert.deepEqual([wrong.levers.checkpointMaxMemory, wrong.rejected], [1610612736, ['valeur invalide : checkpointMaxMemory']]);
});

test('the promptCheckpoint lever (Task 3b): shipped on (S2); a boolean only', () => {
  assert.equal(SHIPPED_LEVERS.promptCheckpoint, true);
  assert.deepEqual(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ promptCheckpoint: false }) }), { levers: { ...SHIPPED_LEVERS, promptCheckpoint: false }, rejected: [] });
  const wrong = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ promptCheckpoint: 'oui' }) });
  assert.deepEqual([wrong.levers.promptCheckpoint, wrong.rejected], [true, ['valeur invalide : promptCheckpoint']]);
});
