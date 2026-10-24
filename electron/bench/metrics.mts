// The benchmark's figures (pure): one TurnFigures per message, from that turn's own turn log lines; the results file
// (BenchRun); and the comparison of two results files. No path ever enters a figure: a results file is shareable.
import type { LoadStage, ModelArchitecture } from '../core/model-types.mts';
import type { ReuseFigures } from '../core/reuse.mts';
import type { PerfLevers } from '../core/perf-levers.mts';
import { TRUNCATED_NOTICE } from '../core/agent.mts';
import { SCENARIO_B_SENTINEL } from './scenarios.mts';

export type PhaseName = 'preparing' | 'loading' | 'reading' | 'thinking' | 'writing' | 'tool';

export interface GenerationFigures {
  step: number; inputTokens: number; outputTokens: number; generationMs: number;
  promptMs: number | null; tokensPerSecond: number | null; reuse: ReuseFigures | null;
}
export interface MemorySample { rssBytes: number; gpuDedicatedBytes: number | null; gpuSharedBytes: number | null }
export interface TurnFigures {
  scenario: 'A' | 'B' | 'C-froid' | 'C-chaud'; message: number;
  phasesMs: Partial<Record<PhaseName, number>>; totalMs: number;
  loadMs: number | null; loadStages: LoadStage[] | null; architecture: ModelArchitecture | null;
  generations: GenerationFigures[]; toolCalls: string[];
  reply: { chars: number; truncated: boolean }; quality: { toolCalled?: boolean; sentinel?: boolean };
  memory: MemorySample;
  placement: { backend: string; gpuLayers: number; totalLayers: number; contextSize: number; vramBytes: number; ramBytes: number } | null;
  perfLines: string[];
}
export interface BenchRun {
  schema: 1; label: string; startedAt: string; gitHead: string;
  model: { file: string; bytes: number }; machine: { cpu: string; logicalCores: number; ramBytes: number };
  settings: { local_context: number | 'max' }; levers: Partial<PerfLevers>;
  toolDefinitions: { chars: number; tokens: number | null }; turns: TurnFigures[];
}

type Line = Record<string, unknown>;
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const timeOf = (line: Line | undefined): number | null => {
  const ms = typeof line?.at === 'string' ? Date.parse(line.at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * One turn's figures from its turn log lines (in order) and what was sampled beside them. `phasesMs` sums each
 * `phase` line's previousMs under its `previous`, plus the last phase up to the `end` line's `at`; tokensPerSecond =
 * outputTokens / (generationMs / 1000), null when generationMs is 0. B's quality: read_file called, and the last reply
 * quotes the sentinel.
 */
export function turnFigures(lines: readonly Line[], meta: { scenario: TurnFigures['scenario']; message: number; memory: MemorySample; placement: TurnFigures['placement']; perfLines: string[] }): TurnFigures {
  const phasesMs: Partial<Record<PhaseName, number>> = {};
  const add = (phase: string, ms: number) => {
    const key = phase as PhaseName;
    phasesMs[key] = (phasesMs[key] ?? 0) + ms;
  };
  let lastPhase: Line | undefined;
  for (const line of lines) {
    if (line.event !== 'phase') continue;
    const previousMs = num(line.previousMs);
    if (typeof line.previous === 'string' && previousMs !== null) add(line.previous, previousMs);
    if (line.phase !== lastPhase?.phase) lastPhase = line;
  }
  const end = lines.find(line => line.event === 'end');
  const endAt = timeOf(end);
  const lastAt = timeOf(lastPhase);
  if (lastPhase && typeof lastPhase.phase === 'string' && endAt !== null && lastAt !== null) add(lastPhase.phase, Math.max(0, endAt - lastAt));

  const ready = lines.find(line => line.event === 'model-ready');
  const generations: GenerationFigures[] = lines.filter(line => line.event === 'generation').map(line => {
    const outputTokens = num(line.outputTokens) ?? 0;
    const generationMs = num(line.generationMs) ?? 0;
    return {
      step: num(line.step) ?? 0,
      inputTokens: num(line.inputTokens) ?? 0,
      outputTokens,
      generationMs,
      promptMs: num(line.promptMs),
      tokensPerSecond: generationMs > 0 ? outputTokens / (generationMs / 1000) : null,
      reuse: (line.reuse as ReuseFigures | undefined) ?? null,
    };
  });
  const toolCalls = lines.filter(line => line.event === 'tool').map(line => String(line.tool ?? ''));
  const replies = lines.filter(line => line.event === 'reply');
  const text = String(replies.at(-1)?.text ?? '');
  const quality: TurnFigures['quality'] = meta.scenario === 'B'
    ? { toolCalled: toolCalls.includes('read_file'), sentinel: replies.some(line => String(line.text ?? '').includes(SCENARIO_B_SENTINEL)) }
    : {};
  const timing = end?.timing as { totalMs?: unknown } | undefined;
  return {
    scenario: meta.scenario, message: meta.message,
    phasesMs, totalMs: num(timing?.totalMs) ?? 0,
    loadMs: num(ready?.loadMs),
    loadStages: (ready?.loadStages as LoadStage[] | undefined) ?? null,
    architecture: (ready?.architecture as ModelArchitecture | undefined) ?? null,
    generations, toolCalls,
    reply: { chars: text.length, truncated: text.includes(TRUNCATED_NOTICE) },
    quality,
    memory: meta.memory,
    placement: meta.placement,
    perfLines: meta.perfLines,
  };
}

export interface ComparisonRow { key: string; metric: string; before: number | null; after: number | null; changePercent: number | null }

const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const round1 = (value: number) => Math.round(value * 10) / 10;

/** The compared metrics of one turn, in table order. */
const METRICS: readonly { metric: string; of: (turn: TurnFigures) => number | null }[] = [
  { metric: 'lecture (ms)', of: turn => sum(turn.generations.map(g => g.promptMs)) },
  { metric: 'jetons évalués', of: turn => sum(turn.generations.map(g => g.inputTokens)) },
  { metric: 'jetons réutilisés', of: turn => sum(turn.generations.map(g => g.reuse?.reused ?? null)) },
  { metric: 'tok/s', of: turn => {
    const ms = turn.generations.reduce((a, g) => a + g.generationMs, 0);
    return ms > 0 ? round1(turn.generations.reduce((a, g) => a + g.outputTokens, 0) / (ms / 1000)) : null;
  } },
  { metric: 'chargement (ms)', of: turn => turn.loadMs },
  { metric: 'RSS (Mio)', of: turn => round1(turn.memory.rssBytes / 1024 ** 2) },
];

/** One row per turn (`${scenario}·${message}`, the turns of `before` first) and metric. */
export function compareRuns(before: BenchRun, after: BenchRun): ComparisonRow[] {
  const keyOf = (turn: TurnFigures) => `${turn.scenario}·${turn.message}`;
  const keys = [...new Set([...before.turns.map(keyOf), ...after.turns.map(keyOf)])];
  const rows: ComparisonRow[] = [];
  for (const key of keys) {
    const a = before.turns.find(turn => keyOf(turn) === key);
    const b = after.turns.find(turn => keyOf(turn) === key);
    for (const { metric, of } of METRICS) {
      const valueBefore = a ? of(a) : null;
      const valueAfter = b ? of(b) : null;
      const changePercent = valueBefore !== null && valueAfter !== null && valueBefore !== 0 ? round1(((valueAfter - valueBefore) / valueBefore) * 100) : null;
      rows.push({ key, metric, before: valueBefore, after: valueAfter, changePercent });
    }
  }
  return rows;
}

const cell = (value: number | null) => (value === null ? '—' : String(value));

/** A Markdown table: `| Tour | Mesure | Avant | Après | Écart |`. */
export function formatComparison(rows: readonly ComparisonRow[]): string {
  const lines = ['| Tour | Mesure | Avant | Après | Écart |', '|---|---|---|---|---|'];
  for (const row of rows) {
    const change = row.changePercent === null ? '—' : `${row.changePercent > 0 ? '+' : ''}${row.changePercent} %`;
    lines.push(`| ${row.key} | ${row.metric} | ${cell(row.before)} | ${cell(row.after)} | ${change} |`);
  }
  return `${lines.join('\n')}\n`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYYMMDD-HHmmss-<label>.json`, in local time; the label lowercased, accents dropped, reduced to [a-z0-9-]. */
export function resultFileName(at: Date, label: string): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const clean = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${stamp}-${clean || 'banc'}.json`;
}
