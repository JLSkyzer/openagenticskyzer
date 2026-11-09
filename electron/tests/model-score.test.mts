import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HardwareInfo } from '../core/hardware.mts';
import type { CatalogueModel, ModelVariant } from '../core/hf-catalogue.mts';
import {
  fitOf, chooseVariant, codeQualityOf, scoreModel, recommend, type Fit, type RecommendationInput,
} from '../core/model-score.mts';
import { CODE_FAMILIES } from '../core/code-families.mts';

const GB = 1e9;
const hardware = (vramGb: number | null, ramGb: number): HardwareInfo => ({
  backend: vramGb === null ? 'cpu' : 'cuda', gpuNames: [], vram: vramGb === null ? null : { total: vramGb * GB, free: vramGb * GB },
  ram: { total: ramGb * GB, free: ramGb * GB }, cpu: { model: 'x', mathCores: 8, logicalCores: 16 }, nvidia: vramGb !== null, notice: null,
} as HardwareInfo);
const variant = (name: string, gb: number, hash: string | null = 'a'.repeat(64)): ModelVariant => ({
  name, files: [{ path: `${name}.gguf`, size: gb * GB, sha256: hash }], totalBytes: gb * GB,
});
const model = (id: string, over: Partial<CatalogueModel> = {}): CatalogueModel => ({
  id, downloads: 10, likes: 1, gated: false, lastModified: '2026-01-01', architecture: null, contextLength: null, chatTemplate: null, tags: [], ...over,
});
const CTX = 8192;

test('fit: a 27B-size file on 8 GB of VRAM and 32 GB of RAM is partial', () => {
  assert.equal(fitOf(variant('q', 12.8), hardware(8, 32), CTX), 'partial');
});
test('fit: 30 GB on 8 GB of VRAM and 16 GB of RAM is none', () => {
  assert.equal(fitOf(variant('q', 30), hardware(8, 16), CTX), 'none');
});
test('fit: 4 GB on 8 GB of VRAM is full', () => {
  assert.equal(fitOf(variant('q', 4), hardware(8, 32), CTX), 'full');
});
test('fit: no card, 4 GB, 32 GB of RAM is slow; too big for the RAM is none', () => {
  assert.equal(fitOf(variant('q', 4), hardware(null, 32), CTX), 'slow');
  assert.equal(fitOf(variant('q', 40), hardware(null, 32), CTX), 'none');
});
test('fit: a card holding less than a quarter of the file is slow', () => {
  assert.equal(fitOf(variant('q', 30), hardware(4, 64), CTX), 'slow');
});
test('fit: a longer context costs more', () => {
  assert.equal(fitOf(variant('q', 6), hardware(8, 32), 4096), 'full');
  assert.equal(fitOf(variant('q', 6), hardware(8, 32), 131072), 'partial');
});

test('stars: pinned values', () => {
  assert.equal(scoreModel({ fit: 'full', tools: 'yes', code: 'strong' }).stars, 5);
  assert.equal(scoreModel({ fit: 'full', tools: 'yes', code: 'unknown' }).stars, 3.5);
  assert.equal(scoreModel({ fit: 'full', tools: 'no', code: 'strong' }).stars, 2);
  assert.equal(scoreModel({ fit: 'full', tools: 'unknown', code: 'strong' }).stars, 3);
  assert.equal(scoreModel({ fit: 'none', tools: 'yes', code: 'strong' }).stars, 0);
  assert.equal(scoreModel({ fit: 'partial', tools: 'yes', code: 'good' }).stars, 4);
  assert.equal(scoreModel({ fit: 'slow', tools: 'yes', code: 'good' }).stars, 3.5);
  assert.equal(scoreModel({ fit: 'slow', tools: 'yes', code: 'strong' }).stars, 4);
});
test('score: always flagged as an estimate', () => {
  assert.equal(scoreModel({ fit: 'full', tools: 'yes', code: 'strong' }).estimated, true);
});

test('sentence: French, no tok/s figure, unknown axes named in words', () => {
  const s = scoreModel({ fit: 'full', tools: 'unknown', code: 'unknown' }).sentence;
  assert.match(s, /outils/i);
  assert.match(s, /inconnu|pas vérifi|non vérifi/i);
  assert.match(s, /code/i);
  for (const fit of ['full', 'partial', 'slow', 'none'] as Fit[]) {
    for (const tools of ['yes', 'no', 'unknown'] as const) {
      for (const code of ['strong', 'good', 'unknown'] as const) {
        const sentence = scoreModel({ fit, tools, code }).sentence;
        assert.ok(sentence.length > 0);
        assert.doesNotMatch(sentence, /tok|\d/i);
      }
    }
  }
});

test('chooseVariant: skips a larger variant whose hash is missing', () => {
  const picked = chooseVariant([variant('Q4', 3), variant('Q6', 5, null), variant('Q2', 2)], hardware(8, 32), CTX);
  assert.equal(picked?.name, 'Q4');
});
test('chooseVariant: largest full, else largest partial, else largest slow, else null', () => {
  assert.equal(chooseVariant([variant('a', 2), variant('b', 5), variant('c', 14)], hardware(8, 32), CTX)?.name, 'b');
  assert.equal(chooseVariant([variant('c', 14), variant('d', 16)], hardware(8, 32), CTX)?.name, 'd');
  assert.equal(chooseVariant([variant('c', 14), variant('d', 16)], hardware(null, 32), CTX)?.name, 'd');
  assert.equal(chooseVariant([variant('z', 60)], hardware(8, 16), CTX), null);
  assert.equal(chooseVariant([], hardware(8, 16), CTX), null);
});

test('codeQualityOf: known families, modified builds keep their base family, others unknown', () => {
  assert.equal(codeQualityOf(model('bartowski/Qwen3-Coder-30B-A3B-Instruct-GGUF')), 'strong');
  assert.equal(codeQualityOf(model('x/Qwen2.5-Coder-7B-Instruct-GGUF')), 'good');
  assert.equal(codeQualityOf(model('x/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF')), 'good');
  assert.equal(codeQualityOf(model('x/some-chat-model-GGUF')), 'unknown');
});
test('CODE_FAMILIES: every entry cites a dated https source', () => {
  assert.ok(CODE_FAMILIES.length > 0);
  for (const f of CODE_FAMILIES) {
    assert.match(f.source, /^https:\/\//);
    assert.match(f.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
});

const item = (id: string, over: { downloads?: number; gated?: boolean; fit?: Fit; tools?: 'yes' | 'no' | 'unknown'; code?: 'strong' | 'good' | 'unknown'; variant?: boolean }): RecommendationInput => ({
  model: model(id, { downloads: over.downloads ?? 1, gated: over.gated ?? false }),
  variant: over.variant === false ? null : variant('Q4', 3),
  score: scoreModel({ fit: over.fit ?? 'full', tools: over.tools ?? 'yes', code: over.code ?? 'good' }),
});

test('recommend: picks the best stars among tools-yes, ties on downloads', () => {
  const r = recommend([item('a', { code: 'good' }), item('b', { code: 'strong' }), item('c', { code: 'strong', downloads: 99 })]);
  assert.equal(r.kind, 'install');
  assert.equal((r as any).item.model.id, 'c');
});
test('recommend: never returns a none-fit, gated or variant-less item', () => {
  const r = recommend([item('a', { fit: 'none' }), item('b', { gated: true }), item('c', { variant: false })]);
  assert.equal(r.kind, 'none');
  if (r.kind === 'none') assert.equal(r.reason, 'no-fit');
});
test('recommend: only tools-unknown candidates give try, tools-no never recommended', () => {
  const r = recommend([item('a', { tools: 'unknown' }), item('b', { tools: 'no' })]);
  assert.equal(r.kind, 'try');
  assert.equal((r as any).item.model.id, 'a');
  assert.equal(recommend([item('b', { tools: 'no' })]).kind, 'none');
});
test('recommend: a tools-yes item wins over a better-starred tools-unknown one', () => {
  const r = recommend([item('u', { tools: 'unknown', code: 'strong' }), item('y', { tools: 'yes', code: 'unknown' })]);
  assert.equal(r.kind, 'install');
});
test('recommend: empty list and gated-only lists', () => {
  assert.equal(recommend([]).kind, 'none');
  const g = recommend([item('a', { gated: true })]);
  assert.deepEqual(g, { kind: 'none', reason: 'gated-only' });
});
