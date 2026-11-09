// The lever switchboard of the LLM performance lot: each optimisation is a lever, so a benchmark can measure it off and
// on in the same build. A shipped value is the one the 27B measured as a gain (session S2, 2026-11-09), or, for what
// no gain was measured on, the behaviour before the lever. The levers are read from OPENAGENT_PERF_LEVERS (a JSON
// object), once per thread.
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
  /** A cap, in bytes, on the memory of a hybrid model's checkpoints (Qwen 3.5/3.6 restore a reused prefix only from
   * one; attention-only models take none); null: none (node-llama-cpp's default). Shipped 1.5 GiB (S2 on the 27B:
   * about 150 Mio of checkpoints per message, the RSS up by 0.1 Gio, mesuré). */
  checkpointMaxMemory: number | null;
  /** Hybrid models: before generating, evaluate the prompt up to where the next turn will render it differently (the
   * thought the template opens, the reply) and take a checkpoint there, so the next turn restores right at its
   * divergence (Task 3b). Shipped true (S2 on the 27B: its second message reads 67 tokens instead of 4143, mesuré); a
   * model that needs no checkpoint skips it. false: LlamaChat reads the whole prompt in one go. */
  promptCheckpoint: boolean;
  /** Lighter tool definitions (Task 6): the built-in tools carry their slimmed descriptions (tool-texts-slim.mts) and the
   * local engine drops schema noise (`$schema`, `title`, `examples`, `$comment`, an empty `required`) from every tool it is
   * sent, MCP ones included. Names and argument contracts never change. Shipped true (S2 on the 27B: tool block 3737 →
   * 3450 tokens, mesuré). false: the modules' own texts and schemas. */
  slimToolDefinitions: boolean;
  /** The re-placement between turns weighs the cost of emptying the cache (Task 12): a reload re-reads the whole
   * conversation, so it asks one more extra layer per REREAD_MS_PER_EXTRA_LAYER of estimated re-read. Shipped off
   * (REPLACE_MIN_LAYERS alone, as today) until a re-placement is measured with and without it [hypothèse]. */
  rereadWeighting: boolean;
  /** Keep the stdio MCP servers alive between turns and calls (Task 14, core/mcp-client.mts::McpPool): one process per
   * exact configuration, stopped on removal, trust withdrawal, a changed configuration, 10 min unused and shutdown.
   * Shipped true (S2, a 1.5 s server: preparing 1.7 s → 0 s per later message, mesuré). false: a process per discovery
   * and per call. */
  mcpKeepAlive: boolean;
}

export const PERF_LEVERS_ENV = 'OPENAGENT_PERF_LEVERS';

export const SHIPPED_LEVERS: Readonly<PerfLevers> = Object.freeze({
  outputCap: 8192,
  thoughtTokens: null,
  performanceTracking: false,
  checkpointMaxMemory: 1610612736,
  promptCheckpoint: true,
  slimToolDefinitions: true,
  rereadWeighting: false,
  mcpKeepAlive: true,
});

const positiveInteger = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
const VALID: { [K in keyof PerfLevers]: (value: unknown) => boolean } = {
  outputCap: positiveInteger,
  thoughtTokens: value => value === null || (Number.isInteger(value) && (value as number) >= 0),
  performanceTracking: value => typeof value === 'boolean',
  checkpointMaxMemory: value => value === null || positiveInteger(value),
  promptCheckpoint: value => typeof value === 'boolean',
  slimToolDefinitions: value => typeof value === 'boolean',
  rereadWeighting: value => typeof value === 'boolean',
  mcpKeepAlive: value => typeof value === 'boolean',
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
