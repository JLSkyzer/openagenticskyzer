import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnFigures, compareRuns, comparability, formatComparison, resultFileName, type BenchRun } from '../bench/metrics.mts';
import { gamesIn } from '../bench/guard.mts';
import { classifyReuse, divergenceAt, formatReuseReport } from '../bench/reuse-report.mts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0, ms)).toISOString();
const memory = { rssBytes: 1, gpuDedicatedBytes: null, gpuSharedBytes: null };
test('turnFigures: phase durations from the turn log, one figure per generation with tok/s and reuse', () => {
  const reuse = { held: 0, common: 0, prompt: 40, evaluated: 40, reused: 0, checkpoints: null };
  const lines = [
    { at: at(0), event: 'turn-start' },
    { at: at(0), event: 'phase', phase: 'preparing', previous: null, previousMs: null },
    { at: at(10), event: 'phase', phase: 'loading', previous: 'preparing', previousMs: 10 },
    { at: at(510), event: 'model-ready', loadMs: 500, loadStages: [{ stage: 'engine', ms: 5, ok: true }], architecture: { hybrid: false, recurrent: false, swaSize: null, mtpWeights: false }, toolsAfterSystem: true },
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
  // The template probe of the model-ready line (Task 4): the run file says whether the context could follow the tools.
  assert.equal(t.toolsAfterSystem, true);
  assert.equal('toolsAfterSystem' in turnFigures(lines.filter(line => line.event !== 'model-ready'), { scenario: 'A', message: 1, memory, placement: null, perfLines: [] }), false);
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
  // The guard's own PowerShell rows: name, pid, window title.
  assert.deepEqual(gamesIn('"java.exe","7","Minecraft* 1.21"\n"Unity.exe","8","Minecraft batch"\n"explorer.exe","9",""'), ['java.exe']);
});

test('compareRuns: a turn missing on one side, an incomplete old file, status, quality and truncation rows, and what makes two runs not comparable', () => {
  const turn = (message: number, extra: Record<string, unknown> = {}) => ({ scenario: 'B', message, phasesMs: {}, totalMs: 1, loadMs: null, loadStages: null, architecture: null, toolCalls: [],
    reply: { chars: 1, truncated: false }, quality: { toolCalled: true, sentinel: false }, memory, placement: null, perfLines: [], status: 'done',
    generations: [{ step: 0, inputTokens: 10, outputTokens: 10, generationMs: 1000, promptMs: 5, tokensPerSecond: 10, reuse: null }], ...extra }) as BenchRun['turns'][number];
  const base: BenchRun = { schema: 1, label: 'x', startedAt: '', gitHead: '', model: { file: 'm.gguf', bytes: 1 }, machine: { cpu: 'c', logicalCores: 1, ramBytes: 1 },
    settings: { local_context: 32768 }, levers: { outputCap: 1024, thoughtTokens: 512 }, toolDefinitions: { chars: 1, tokens: null }, backend: 'cuda', nodeLlamaCpp: '3.21.1', turns: [turn(1), turn(2)] };
  // An older or partial file: no memory, no generations, no status.
  const after: BenchRun = { ...base, turns: [turn(1, { reply: { chars: 1, truncated: true }, memory: undefined, generations: undefined, status: 'stopped' })] };
  const rows = compareRuns(base, after);
  assert.deepEqual(rows.find(r => r.key === 'B·2' && r.metric === 'jetons évalués'), { key: 'B·2', metric: 'jetons évalués', before: 10, after: null, changePercent: null });
  assert.deepEqual(rows.find(r => r.key === 'B·1' && r.metric === 'statut'), { key: 'B·1', metric: 'statut', before: 'done', after: 'stopped', changePercent: null });
  assert.deepEqual(rows.find(r => r.key === 'B·1' && r.metric === 'tronquée'), { key: 'B·1', metric: 'tronquée', before: 'non', after: 'oui', changePercent: null });
  assert.equal(rows.find(r => r.key === 'B·1' && r.metric === 'qualité')?.before, 'outil oui · code non');
  assert.equal(rows.find(r => r.key === 'B·1' && r.metric === 'RSS (Mio)')?.after, null);
  assert.match(formatComparison(rows), /\| B·2 \| jetons évalués \| 10 \| — \| — \|/);
  assert.deepEqual(comparability(base, { ...base, levers: { ...base.levers, keepThought: true } as never }), []);
  assert.deepEqual(comparability(base, { ...base, model: { file: 'n.gguf', bytes: 1 }, settings: { local_context: 16384 }, backend: 'vulkan', nodeLlamaCpp: '3.22.0', levers: { outputCap: 64, thoughtTokens: 512 } }), [
    'modèle différent : m.gguf (1 octets) → n.gguf (1 octets)',
    'contexte différent : 32768 → 16384',
    'moteur différent : cuda → vulkan',
    'node-llama-cpp différent : 3.21.1 → 3.22.0',
    'plafond différent : outputCap 1024 → 64',
  ]);
  // --touch-memory (Task 4): both runs must change the memory before the same message, or neither.
  assert.deepEqual(comparability({ ...base, touchMemory: 3 }, { ...base, touchMemory: 3 }), []);
  assert.deepEqual(comparability(base, { ...base, touchMemory: 3 }), ['mémoire du projet modifiée différemment : jamais → avant A·3']);
  // --idle-before-send and --mcp-fake (Task 7): same conditions on both sides, or the timings say nothing.
  assert.deepEqual(comparability({ ...base, idleBeforeSendMs: 5000, mcpFakeMs: 1500 }, { ...base, idleBeforeSendMs: 5000, mcpFakeMs: 1500 }), []);
  assert.deepEqual(comparability(base, { ...base, idleBeforeSendMs: 5000, mcpFakeMs: 1500 }), [
    'attente avant le premier message différente : aucune → 5000 ms',
    'serveur MCP factice différent : aucun → 1500 ms',
  ]);
});

const fig = (held: number, common: number, prompt: number, evaluated: number) => ({ held, common, prompt, evaluated, reused: Math.max(0, prompt - evaluated), checkpoints: null });
/** A BenchRun with one A turn per figure: message i + 1, one generation at step 0. */
const runOf = (figs: ReturnType<typeof fig>[]): BenchRun => ({ schema: 1, label: 'x', startedAt: '', gitHead: '', model: { file: 'm.gguf', bytes: 1 },
  machine: { cpu: 'c', logicalCores: 1, ramBytes: 1 }, settings: { local_context: 32768 }, levers: {}, toolDefinitions: { chars: 1, tokens: null },
  turns: figs.map((reuse, i) => ({ scenario: 'A', message: i + 1, phasesMs: {}, totalMs: 1, loadMs: null, loadStages: null, architecture: null, toolCalls: [],
    reply: { chars: 1, truncated: false }, quality: {}, memory, placement: null, perfLines: [], status: 'done',
    generations: [{ step: 0, inputTokens: reuse.evaluated, outputTokens: 10, generationMs: 1000, promptMs: 5, tokensPerSecond: 10, reuse }] })) });
test('classifyReuse: cold, reused, and a hybrid checkpoint miss', () => {
  assert.equal(classifyReuse(fig(0, 0, 4074, 4074)), 'froid');
  assert.equal(classifyReuse(fig(4184, 4091, 4120, 30)), 'réutilisé');
  assert.equal(classifyReuse(fig(4184, 4091, 4120, 4120)), 'point de sauvegarde manquant');
  // Held, but diverging at the start (the Task 4 case): 0 reused is not « réutilisé ».
  assert.equal(classifyReuse(fig(4184, 0, 4120, 4120)), 'divergent dès le début');
  assert.equal(classifyReuse(fig(4184, 16, 4120, 4120)), 'divergent dès le début');
  assert.equal(classifyReuse(fig(4184, 17, 4120, 4120)), 'point de sauvegarde manquant');
  // The prefix taken back, but the whole prompt read again anyway: not « réutilisé ».
  assert.equal(classifyReuse({ ...fig(4184, 4091, 4120, 4110), reused: 4091 }), 'point de sauvegarde manquant');
});
test('divergenceAt and the report line', () => {
  assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4050, 4120, 4120)), 'dans le prompt précédent');
  // Within RESTORE_SLACK of an approximate prompt end: the reply side.
  assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4071, 4120, 4120)), 'dans la réponse précédente');
  assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4058, 4120, 4120)), 'dans la réponse précédente');
  assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4057, 4120, 4120)), 'dans le prompt précédent');
  assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4080, 4120, 4120)), 'dans la réponse précédente');
  assert.equal(divergenceAt(null, fig(0, 0, 1, 1)), null);
  // A·2 holds fig(4184, 4080, 4120, 4120) after A·1's fig(0, 0, 4074, 4074).
  assert.match(formatReuseReport(runOf([fig(0, 0, 4074, 4074), fig(4184, 4080, 4120, 4120)])),
    /^A·2 étape 0 : tenus 4184 · communs 4080 · relus 4120 · réutilisés 0 — point de sauvegarde manquant \(dans la réponse précédente\)$/m);
});
