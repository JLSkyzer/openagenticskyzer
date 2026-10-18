// « Contexte des modèles locaux »: the setting, its default, and the one rule that turns it into the engine's
// context size. Ruling F6: max_tokens does NOT cap the engine context — it stays a cap on the request window only
// (effectiveWindow, unchanged), « comme aujourd'hui ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGgufFileInfo, GgufInsights } from 'node-llama-cpp';
import { localContextSize, LOCAL_CONTEXT_CHOICES, DEFAULT_LOCAL_CONTEXT, effectiveWindow, MIN_LOCAL_CONTEXT } from '../core/context-budget.mts';
import { SettingsService } from '../core/settings.mts';
import { withTrainContext } from './support/gguf-fixture.mts';

const stories260K = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

async function tempDir(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-local-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('localContextSize: the setting, capped by the train size, floored at MIN_LOCAL_CONTEXT; max_tokens plays no part', () => {
  const cases: [any, number | undefined, number][] = [
    [32768, 2048, 16384], [32768, 131072, 32768], ['max', 131072, 131072], [131072, 32768, 32768],
    [65536, 131072, 65536], ['max', undefined, 32768], [16384, undefined, 16384], [131072, undefined, 131072],
    ['max', 8192, 16384], [65536, 40960, 40960],
  ];
  for (const [setting, train, expected] of cases) {
    assert.equal(localContextSize({ setting, trainContextSize: train }), expected, JSON.stringify([setting, train]));
  }
  // The request window is still capped by max_tokens, exactly as before — on top of the engine context, not inside it.
  assert.equal(effectiveWindow(localContextSize({ setting: 65536, trainContextSize: 131072 }), 24576), 24576);
  assert.equal(MIN_LOCAL_CONTEXT, 16384);
});

test('the five choices and the 32768 default', () => {
  assert.deepEqual([...LOCAL_CONTEXT_CHOICES], [16384, 32768, 65536, 131072, 'max']);
  assert.equal(DEFAULT_LOCAL_CONTEXT, 32768);
});

test('local_context setting: default 32768, the five values accepted, anything else refused with « Paramètre invalide : local_context »', async t => {
  const s = new SettingsService(await tempDir(t));
  assert.equal((await s.publicGlobal()).local_context, 32768);
  for (const v of LOCAL_CONTEXT_CHOICES) {
    await s.saveGlobal({ local_context: v });
    assert.equal((await s.global()).local_context, v);
    assert.equal((await s.publicGlobal()).local_context, v);
  }
  for (const v of [4096, '32768', 'MAX', null]) {
    await assert.rejects(s.saveGlobal({ local_context: v }), { message: 'Paramètre invalide : local_context' }, JSON.stringify(v));
  }
});

test('withTrainContext writes a real GGUF whose train context node-llama-cpp reads back', async t => {
  const tmp = join(await tempDir(t), 'patched.gguf');
  const before = (await GgufInsights.from(await readGgufFileInfo(stories260K))).trainContextSize;
  await withTrainContext(stories260K, tmp, 131072);
  assert.equal((await GgufInsights.from(await readGgufFileInfo(tmp))).trainContextSize, 131072);
  assert.equal(statSync(tmp).size, statSync(stories260K).size);
  assert.equal((await GgufInsights.from(await readGgufFileInfo(stories260K))).trainContextSize, before, 'the fixture itself is untouched');
  assert.notEqual(before, 131072);
});
