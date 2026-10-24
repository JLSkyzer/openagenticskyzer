import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnFigures, compareRuns, formatComparison, resultFileName, type BenchRun } from '../bench/metrics.mts';
import { gamesIn } from '../bench/guard.mts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0, ms)).toISOString();
const memory = { rssBytes: 1, gpuDedicatedBytes: null, gpuSharedBytes: null };
test('turnFigures: phase durations from the turn log, one figure per generation with tok/s and reuse', () => {
  const reuse = { held: 0, common: 0, prompt: 40, evaluated: 40, reused: 0, checkpoints: null };
  const lines = [
    { at: at(0), event: 'turn-start' },
    { at: at(0), event: 'phase', phase: 'preparing', previous: null, previousMs: null },
    { at: at(10), event: 'phase', phase: 'loading', previous: 'preparing', previousMs: 10 },
    { at: at(510), event: 'model-ready', loadMs: 500, loadStages: [{ stage: 'engine', ms: 5, ok: true }], architecture: { hybrid: false, recurrent: false, swaSize: null, mtpWeights: false } },
    { at: at(510), event: 'phase', phase: 'reading', previous: 'loading', previousMs: 500 },
    { at: at(710), event: 'phase', phase: 'writing', previous: 'reading', previousMs: 200 },
    { at: at(1710), event: 'generation', step: 0, inputTokens: 40, outputTokens: 50, generationMs: 1000, promptMs: 200, reuse },
    { at: at(1710), event: 'reply', step: 0, text: 'abc', toolCalls: 0 },
    { at: at(1720), event: 'end', kind: 'done', timing: { totalMs: 1720 } },
  ];
  const t = turnFigures(lines, { scenario: 'A', message: 1, memory, placement: null, perfLines: [] });
  assert.deepEqual(t.phasesMs, { preparing: 10, loading: 500, reading: 200, writing: 1010 });
  assert.equal(t.loadMs, 500);
  assert.deepEqual(t.generations, [{ step: 0, inputTokens: 40, outputTokens: 50, generationMs: 1000, promptMs: 200, tokensPerSecond: 50, reuse }]);
  assert.deepEqual(t.reply, { chars: 3, truncated: false });
});
test('compareRuns and formatComparison: one row per tour and metric, with the change in percent', () => {
  const run = (evaluated: number, promptMs: number): BenchRun => ({ schema: 1, label: 'x', startedAt: '', gitHead: '', model: { file: 'm.gguf', bytes: 1 },
    machine: { cpu: 'c', logicalCores: 1, ramBytes: 1 }, settings: { local_context: 32768 }, levers: {}, toolDefinitions: { chars: 1, tokens: null },
    turns: [{ scenario: 'A', message: 2, phasesMs: {}, totalMs: 1, loadMs: null, loadStages: null, architecture: null, toolCalls: [], reply: { chars: 1, truncated: false },
      quality: {}, memory, placement: null, perfLines: [],
      generations: [{ step: 0, inputTokens: evaluated, outputTokens: 10, generationMs: 1000, promptMs, tokensPerSecond: 10, reuse: null }] }] });
  const rows = compareRuns(run(4000, 29000), run(400, 2900));
  assert.deepEqual(rows.find(r => r.metric === 'jetons évalués'), { key: 'A·2', metric: 'jetons évalués', before: 4000, after: 400, changePercent: -90 });
  assert.match(formatComparison(rows), /^\| Tour \| Mesure \| Avant \| Après \| Écart \|\n/);
  assert.equal(resultFileName(new Date(2026, 9, 25, 9, 5, 7), '27B T3 Avant!'), '20261025-090507-27b-t3-avant.json');
});
test('gamesIn: a Minecraft client counts; Unity batch and AxionEngine processes are tolerated', () => {
  const csv = [
    '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"',
    '"javaw.exe","100","Console","1","900 000 K","Running","u","0:10:00","Minecraft 1.21"',
    '"Unity.exe","200","Console","1","1 K","Running","u","0:00:01","N/A"',
    '"AxionEngine.Tests.exe","300","Console","1","1 K","Running","u","0:00:01","N/A"',
  ].join('\r\n');
  assert.deepEqual(gamesIn(csv), ['javaw.exe']);
  assert.deepEqual(gamesIn(csv.split('\r\n').filter(l => !l.includes('javaw')).join('\r\n')), []);
});
