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
  /** The generation's id (its `[perf]` marker's too); absent when the line has none. */
  generationId?: string;
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
  /** How the turn ended (its `end` line); null when the log has no end. */
  status?: 'done' | 'stopped' | 'error' | null;
}
export interface BenchRun {
  schema: 1; label: string; startedAt: string; gitHead: string;
  model: { file: string; bytes: number }; machine: { cpu: string; logicalCores: number; ramBytes: number };
  settings: { local_context: number | 'max' }; levers: Partial<PerfLevers>;
  toolDefinitions: { chars: number; tokens: number | null }; turns: TurnFigures[];
  // Optional: older or partial files may lack them (compare reads them as unknown).
  /** The levers asked on the command line (`levers` is what the worker applied). */
  askedLevers?: Partial<PerfLevers>;
  /** The backend the turns ran on (their placement), null when no turn loaded the model. */
  backend?: string | null;
  nodeLlamaCpp?: string;
  /** B's quality counts as a failure (a real model, not the toy). */
  qualityGate?: boolean;
  /** What failed: a turn not done, a timeout, a quality miss, a session that did not end. No path in them. */
  failures?: string[];
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
      ...(typeof line.generationId === 'string' ? { generationId: line.generationId } : {}),
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
    status: end && ['done', 'stopped', 'error'].includes(String(end.kind)) ? end.kind as TurnFigures['status'] : null,
  };
}

export interface ComparisonRow { key: string; metric: string; before: number | string | null; after: number | string | null; changePercent: number | null }

const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const round1 = (value: number) => Math.round(value * 10) / 10;
const yesNo = (value: boolean | undefined) => (value === undefined ? '?' : value ? 'oui' : 'non');
/** A turn's generations; an incomplete file's missing ones read as none. */
const gens = (turn: TurnFigures): Partial<GenerationFigures>[] => (Array.isArray(turn.generations) ? turn.generations : []);

/** The compared metrics of one turn, in table order. Every field may be missing in an older or partial file. */
const METRICS: readonly { metric: string; of: (turn: TurnFigures) => number | string | null }[] = [
  { metric: 'statut', of: turn => turn.status ?? null },
  { metric: 'lecture (ms)', of: turn => sum(gens(turn).map(g => num(g?.promptMs))) },
  { metric: 'jetons évalués', of: turn => sum(gens(turn).map(g => num(g?.inputTokens))) },
  { metric: 'jetons réutilisés', of: turn => sum(gens(turn).map(g => num(g?.reuse?.reused))) },
  { metric: 'tok/s', of: turn => {
    const ms = gens(turn).reduce((a, g) => a + (num(g?.generationMs) ?? 0), 0);
    return ms > 0 ? round1(gens(turn).reduce((a, g) => a + (num(g?.outputTokens) ?? 0), 0) / (ms / 1000)) : null;
  } },
  { metric: 'chargement (ms)', of: turn => num(turn.loadMs) },
  { metric: 'RSS (Mio)', of: turn => { const rss = num(turn.memory?.rssBytes); return rss === null ? null : round1(rss / 1024 ** 2); } },
  { metric: 'tronquée', of: turn => (turn.reply ? yesNo(turn.reply.truncated) : null) },
  { metric: 'qualité', of: turn => (turn.quality && (turn.quality.toolCalled !== undefined || turn.quality.sentinel !== undefined)
    ? `outil ${yesNo(turn.quality.toolCalled)} · code ${yesNo(turn.quality.sentinel)}` : null) },
];

/** One row per turn (`${scenario}·${message}`, the turns of `before` first) and metric; a turn missing on one side
 * reads as null there. */
export function compareRuns(before: BenchRun, after: BenchRun): ComparisonRow[] {
  const keyOf = (turn: TurnFigures) => `${turn.scenario}·${turn.message}`;
  const turnsOf = (run: BenchRun) => (Array.isArray(run.turns) ? run.turns : []);
  const keys = [...new Set([...turnsOf(before).map(keyOf), ...turnsOf(after).map(keyOf)])];
  const rows: ComparisonRow[] = [];
  for (const key of keys) {
    const a = turnsOf(before).find(turn => keyOf(turn) === key);
    const b = turnsOf(after).find(turn => keyOf(turn) === key);
    for (const { metric, of } of METRICS) {
      const valueBefore = a ? of(a) : null;
      const valueAfter = b ? of(b) : null;
      const changePercent = typeof valueBefore === 'number' && typeof valueAfter === 'number' && valueBefore !== 0 ? round1(((valueAfter - valueBefore) / valueBefore) * 100) : null;
      rows.push({ key, metric, before: valueBefore, after: valueAfter, changePercent });
    }
  }
  return rows;
}

/** The caps the protocol keeps equal on both sides: they bound a run, they are not the lever under test. */
const CAPS = ['outputCap', 'thoughtTokens'] as const;

/** Why `before` and `after` cannot be compared: another model, context or backend, or other caps. The lever under
 * test may differ (it is the point of the comparison). [] = comparable. */
export function comparability(before: BenchRun, after: BenchRun): string[] {
  const issues: string[] = [];
  const model = (run: BenchRun) => `${run.model?.file ?? '?'} (${run.model?.bytes ?? '?'} octets)`;
  if (model(before) !== model(after)) issues.push(`modèle différent : ${model(before)} → ${model(after)}`);
  const context = (run: BenchRun) => String(run.settings?.local_context ?? '?');
  if (context(before) !== context(after)) issues.push(`contexte différent : ${context(before)} → ${context(after)}`);
  const backend = (run: BenchRun) => run.backend ?? '?';
  if (backend(before) !== backend(after)) issues.push(`moteur différent : ${backend(before)} → ${backend(after)}`);
  for (const cap of CAPS) {
    const a = before.levers?.[cap];
    const b = after.levers?.[cap];
    if (a !== b) issues.push(`plafond différent : ${cap} ${a ?? '?'} → ${b ?? '?'}`);
  }
  return issues;
}

const cell = (value: number | string | null) => (value === null ? '—' : String(value));

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
