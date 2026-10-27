// The lever switchboard of the LLM performance lot: each optimisation is a lever whose shipped value is today's
// behaviour, so a benchmark can measure it off and on in the same build. The levers are read from
// OPENAGENT_PERF_LEVERS (a JSON object), once per thread.
//
// A bench tool, never a user setting (ruling F6): the variable is honoured only where it is allowed — a plain Node
// process (the bench, the tests), or a worker whose creator passed `workerData.perfLeversAllowed: true`. main.cjs
// passes `!app.isPackaged`, so the packaged app ignores the variable and says so once in its log.
import { isMainThread, workerData } from 'node:worker_threads';

export interface PerfLevers {
  /** The engine's output cap, in tokens: what the agent asks for at most (shipped 8192 = LOCAL_OUTPUT_CAP). */
  outputCap: number;
  /** A bench cap on thought tokens; null: none (no `budgets` is sent, as today — ruling F5). */
  thoughtTokens: number | null;
  /** llama.cpp's performance tracking, its timings printed after each generation (`[perf]` marker). */
  performanceTracking: boolean;
  /** Hybrid models (Qwen 3.5/3.6) restore a reused prefix only from a checkpoint: one taken every this many evaluated
   * tokens (shipped 8192 = node-llama-cpp's default). Ignored by attention-only models (`needsCheckpoints` false). */
  checkpointInterval: number;
  /** The checkpoints kept per sequence (shipped 32 = node-llama-cpp's default). */
  checkpointMax: number;
  /** A cap, in bytes, on the checkpoints' memory; null: none (node-llama-cpp's default). An interval below 8192 needs
   * one, so a shorter interval never grows the RAM unbounded. */
  checkpointMaxMemory: number | null;
  /** Hybrid models: before generating, evaluate the prompt up to where the next turn will render it differently (the
   * thought the template opens, the reply) and take a checkpoint there, so the next turn restores right at its
   * divergence (Task 3b). Shipped false: LlamaChat reads the whole prompt in one go, as today. */
  promptCheckpoint: boolean;
  /** Where the project context (OPENAGENT.md, custom prompt, memory, learnings) goes in a local model's prompt (Task 4):
   * `'system'` heads the system text, before the tools, as today; `'after-tools'` is its own item after the tool block,
   * applied only to a template that renders the tools after the system text (the `[chat]` probe). Shipped 'system'. */
  contextPlacement: 'system' | 'after-tools';
  /** Send the previous turn's last reply, and the replies of the turn in progress, back with their thought (a `thought`
   * segment), so the next prompt renders the reply as the model wrote it (Task 5). Applied only where the template renders
   * a resent thought in its place (the `[chat]` probe). Shipped false: the reasoning never goes back, as today. */
  keepThought: boolean;
  /** Lighter tool definitions (Task 6): the built-in tools carry their slimmed descriptions (tool-texts-slim.mts) and the
   * local engine drops schema noise (`$schema`, `title`, `examples`, `$comment`, an empty `required`) from every tool it is
   * sent, MCP ones included. Names and argument contracts never change. Shipped false: today's texts and schemas. */
  slimToolDefinitions: boolean;
  /** Start the engine (the Llama: node-llama-cpp's binary test, then the backend) when the worker starts, if a local
   * model is active (Task 7), so the first turn need not wait for it. Shipped false: it starts on the first turn, or on
   * the first visit to the Matériel tab, as today. */
  engineAtBoot: boolean;
  /** Load the model while the turn's tools (MCP discovery included) and instructions are prepared, instead of after them
   * (Task 7). The page then shows « Chargement » during that preparation (F31). Shipped false: the load follows them. */
  overlapLoad: boolean;
}

export const PERF_LEVERS_ENV = 'OPENAGENT_PERF_LEVERS';

export const SHIPPED_LEVERS: Readonly<PerfLevers> = Object.freeze({
  outputCap: 8192,
  thoughtTokens: null,
  performanceTracking: false,
  checkpointInterval: 8192,
  checkpointMax: 32,
  checkpointMaxMemory: null,
  promptCheckpoint: false,
  contextPlacement: 'system',
  keepThought: false,
  slimToolDefinitions: false,
  engineAtBoot: false,
  overlapLoad: false,
});

/** node-llama-cpp's own checkpoint interval (3.21.1, `defaultCheckpointOptions`): below it, a memory cap is required. */
const NLC_CHECKPOINT_INTERVAL = 8192;

const positiveInteger = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
const VALID: { [K in keyof PerfLevers]: (value: unknown) => boolean } = {
  outputCap: positiveInteger,
  thoughtTokens: value => value === null || (Number.isInteger(value) && (value as number) >= 0),
  performanceTracking: value => typeof value === 'boolean',
  checkpointInterval: positiveInteger,
  checkpointMax: positiveInteger,
  checkpointMaxMemory: value => value === null || positiveInteger(value),
  promptCheckpoint: value => typeof value === 'boolean',
  contextPlacement: value => value === 'system' || value === 'after-tools',
  keepThought: value => typeof value === 'boolean',
  slimToolDefinitions: value => typeof value === 'boolean',
  engineAtBoot: value => typeof value === 'boolean',
  overlapLoad: value => typeof value === 'boolean',
};

/** The levers `env` asks for: each valid key overrides its shipped value; an unknown key, a wrong type or invalid
 * JSON is named in `rejected`, and the shipped value stays. */
export function readPerfLevers(env: NodeJS.ProcessEnv = process.env): { levers: Readonly<PerfLevers>; rejected: string[] } {
  const raw = env[PERF_LEVERS_ENV];
  if (raw === undefined || raw.trim() === '') return { levers: SHIPPED_LEVERS, rejected: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { levers: SHIPPED_LEVERS, rejected: ['JSON invalide'] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { levers: SHIPPED_LEVERS, rejected: ['JSON invalide'] };
  const levers: Record<string, unknown> = { ...SHIPPED_LEVERS };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(VALID, key)) rejected.push(`clé inconnue : ${key}`);
    else if (!VALID[key as keyof PerfLevers](value)) rejected.push(`valeur invalide : ${key}`);
    else levers[key] = value;
  }
  // A rule across keys: more checkpoints than node-llama-cpp takes are allowed only under a memory cap.
  if ((levers.checkpointInterval as number) < NLC_CHECKPOINT_INTERVAL && levers.checkpointMaxMemory === null) {
    rejected.push('valeur invalide : checkpointInterval sans checkpointMaxMemory');
    levers.checkpointInterval = SHIPPED_LEVERS.checkpointInterval;
  }
  return { levers: Object.freeze(levers as unknown as PerfLevers), rejected };
}

/** The levers in effect for `env`, and the lines to log about them: where the variable is not `allowed`, the shipped
 * levers (and a notice when it is set); else readPerfLevers, each rejection, and every lever away from its shipped
 * value (`actifs`). */
export function leversInEffect(env: NodeJS.ProcessEnv, allowed: boolean): { levers: Readonly<PerfLevers>; notices: string[] } {
  if (!allowed) {
    const set = (env[PERF_LEVERS_ENV] ?? '').trim() !== '';
    return { levers: SHIPPED_LEVERS, notices: set ? [`[levers] ${PERF_LEVERS_ENV} ignoré : réservé au banc d'essai, hors application empaquetée`] : [] };
  }
  const { levers, rejected } = readPerfLevers(env);
  const active = (Object.keys(SHIPPED_LEVERS) as (keyof PerfLevers)[])
    .filter(key => levers[key] !== SHIPPED_LEVERS[key])
    .map(key => `${key}=${JSON.stringify(levers[key])}`);
  return { levers, notices: [...rejected.map(r => `[levers] ${r}`), ...(active.length ? [`[levers] actifs : ${active.join(', ')}`] : [])] };
}

/** Whether this thread may honour the variable: a plain Node process, or a worker created with
 * `workerData.perfLeversAllowed: true` (main.cjs: unpackaged only). */
export function perfLeversAllowed(): boolean {
  return isMainThread || (workerData as { perfLeversAllowed?: unknown } | null)?.perfLeversAllowed === true;
}

let current: Readonly<PerfLevers> | null = null;

/** The levers in effect in this thread, read once; each notice is logged once. */
export function perfLevers(): Readonly<PerfLevers> {
  if (current) return current;
  const { levers, notices } = leversInEffect(process.env, perfLeversAllowed());
  for (const notice of notices) console.warn(notice);
  current = levers;
  return current;
}
