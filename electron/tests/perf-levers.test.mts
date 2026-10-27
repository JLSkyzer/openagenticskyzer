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
  // engineAtBoot and overlapLoad (Task 7, F19): shipped off; booleans only.
  assert.deepEqual([SHIPPED_LEVERS.engineAtBoot, SHIPPED_LEVERS.overlapLoad], [false, false]);
  const load = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ engineAtBoot: true, overlapLoad: true }) }).levers;
  assert.deepEqual([load.engineAtBoot, load.overlapLoad], [true, true]);
  const badLoad = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ engineAtBoot: 'oui', overlapLoad: 1 }) });
  assert.deepEqual([badLoad.levers.engineAtBoot, badLoad.levers.overlapLoad, badLoad.rejected], [false, false, ['valeur invalide : engineAtBoot', 'valeur invalide : overlapLoad']]);
  // numericLimitLoad (Task 8, F19): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.numericLimitLoad, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ numericLimitLoad: true }) }).levers.numericLimitLoad, true);
  const numeric = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ numericLimitLoad: 'oui' }) });
  assert.deepEqual([numeric.levers.numericLimitLoad, numeric.rejected], [false, ['valeur invalide : numericLimitLoad']]);
  // inputLookup (Task 10, F19): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.inputLookup, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ inputLookup: true }) }).levers.inputLookup, true);
  const lookup = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ inputLookup: 'oui' }) });
  assert.deepEqual([lookup.levers.inputLookup, lookup.rejected], [false, ['valeur invalide : inputLookup']]);
  // batchSize, threads and kvCacheType (Task 11, F19): shipped at node-llama-cpp's defaults (null, null, 'F16');
  // positive integers (or null) for the first two, 'F16' or 'Q8_0' for the KV cache.
  assert.deepEqual([SHIPPED_LEVERS.batchSize, SHIPPED_LEVERS.threads, SHIPPED_LEVERS.kvCacheType], [null, null, 'F16']);
  const context = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ batchSize: 1024, threads: 6, kvCacheType: 'Q8_0' }) });
  assert.deepEqual([context.levers.batchSize, context.levers.threads, context.levers.kvCacheType, context.rejected], [1024, 6, 'Q8_0', []]);
  const badContext = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ batchSize: 0, threads: 2.5, kvCacheType: 'Q4_0' }) });
  assert.deepEqual([badContext.levers.batchSize, badContext.levers.threads, badContext.levers.kvCacheType, badContext.rejected],
    [null, null, 'F16', ['valeur invalide : batchSize', 'valeur invalide : threads', 'valeur invalide : kvCacheType']]);
  // rereadWeighting (Task 12, F19): shipped off; a boolean only.
  assert.equal(SHIPPED_LEVERS.rereadWeighting, false);
  assert.equal(readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ rereadWeighting: true }) }).levers.rereadWeighting, true);
  const reread = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ rereadWeighting: 'oui' }) });
  assert.deepEqual([reread.levers.rereadWeighting, reread.rejected], [false, ['valeur invalide : rereadWeighting']]);
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
