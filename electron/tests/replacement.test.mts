// Re-placement between turns (final fix wave, item 4; the user: « à chaque fin de message il re analyse ce qu'il peut
// allouer en rapide si ça cause pas un ralentissement »). The decision is pure and cheap: the free VRAM now against the
// free VRAM the load saw, in layers of this model. Only a model the load could not place as node-llama-cpp wanted
// (processor fallback, or fewer layers) is ever reloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replacementDecision, REPLACE_MIN_LAYERS } from '../core/local-engine.mts';

const MIB = 1024 ** 2;
// The 27B of 2026-10-24: 66 layers, about 189 MiB each on the card (4724 MiB for 25 layers).
const base = { outcome: 'fallback' as const, gpuLayers: 0, totalLayers: 66, freeAtLoad: 7106 * MIB, freeNow: 7106 * MIB, loadedVram: 1570 * MIB, bytesPerLayer: 189 * MIB };

test('nothing changed since the load: no reload, whatever the outcome', () => {
  for (const outcome of ['fallback', 'step-down'] as const) {
    const decision = replacementDecision({ ...base, outcome, freeNow: base.freeAtLoad - base.loadedVram });
    assert.equal(decision.replace, false, outcome);
    assert.equal(decision.extraLayers, 0);
  }
});

test('a direct placement is never reloaded, even with the card emptied', () => {
  assert.equal(replacementDecision({ ...base, outcome: 'direct', gpuLayers: 25, freeNow: 8000 * MIB }).replace, false);
});

test('a direct load under a remembered layer limit (limited) can still be raised by the re-placement', () => {
  const at = (extra: number) => base.freeAtLoad - base.loadedVram + extra * base.bytesPerLayer;
  const yes = replacementDecision({ ...base, outcome: 'direct', limited: true, gpuLayers: 19, freeNow: at(4) });
  assert.equal(yes.replace, true);
  assert.match(yes.reason, /^19 couches, environ 4 couches de plus/);
  assert.equal(replacementDecision({ ...base, outcome: 'direct', limited: true, gpuLayers: 19, freeNow: at(3) }).replace, false);
});

test(`clearly more room (≥ ${REPLACE_MIN_LAYERS} layers of this model) reloads a fallback or a step-down; less does not`, () => {
  assert.equal(REPLACE_MIN_LAYERS, 4);
  const at = (extra: number) => base.freeAtLoad - base.loadedVram + extra * base.bytesPerLayer;
  for (const outcome of ['fallback', 'step-down'] as const) {
    const gpuLayers = outcome === 'fallback' ? 0 : 22;
    const yes = replacementDecision({ ...base, outcome, gpuLayers, freeNow: at(4) });
    assert.equal(yes.replace, true, outcome);
    assert.equal(yes.extraLayers, 4);
    assert.match(yes.reason, /4 couches/);
    assert.equal(replacementDecision({ ...base, outcome, gpuLayers, freeNow: at(3.9) }).replace, false, `${outcome}: 3.9 layers is not clearly more`);
  }
});

test('the game closed: a fallback with 2 GiB more free is reloaded', () => {
  const decision = replacementDecision({ ...base, freeAtLoad: 2000 * MIB, freeNow: 4000 * MIB });
  assert.equal(decision.replace, true);
  assert.ok(decision.extraLayers >= 18, String(decision.extraLayers));
});

test('every layer already on the card, or a VRAM figure missing: no reload', () => {
  assert.equal(replacementDecision({ ...base, outcome: 'step-down', gpuLayers: 66, freeNow: 9000 * MIB }).replace, false);
  assert.equal(replacementDecision({ ...base, freeAtLoad: null, freeNow: 9000 * MIB }).replace, false);
  assert.equal(replacementDecision({ ...base, freeNow: null }).replace, false);
  assert.equal(replacementDecision({ ...base, bytesPerLayer: 0, freeNow: 9000 * MIB }).replace, false);
});
