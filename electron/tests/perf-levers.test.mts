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
});
