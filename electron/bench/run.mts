// The benchmark of the local LLM (plan 2026-10-25-llm-performance, Task 1): scenarios A, B and C played on the real
// worker, in fresh processes on temp data homes, and one dated results file (no path in it) per run.
//
//   node --experimental-strip-types bench/run.mts --model <gguf> --label <name> [--scenarios A,B,C] [--context 32768]
//        [--lever key=value]… [--out <dir>]
//
// The 27B command of the benchmark protocol (with the user present, never while a game runs), word for word:
//
//   node --experimental-strip-types bench/guard.mts && node --experimental-strip-types bench/run.mts --model "<chemin donné par l'utilisateur>" --label 27b-t<n>-avant --context 32768 --lever outputCap=1024 --lever thoughtTokens=512 --scenarios <S> > ../.superpowers/runs/bench-27b-t<n>-avant.log 2>&1; echo exit $?
//
// Sessions, each a fresh process (bench/child.mts):
// - S1 = A then B in one worker: A in an empty folder, B in a folder holding note-banc.txt;
// - S2 = « C-froid »: a fresh data home, one message;
// - S3 = « C-chaud »: a NEW process on S2's home (its layer-limits.v1.json kept), one message.
// The children's output goes to `<out>/<file>.log`; the `[perf]` markers cut it into each generation's perfLines.
// Exit codes: 0 ok, 2 bad arguments (a rejected lever included: ruling F24), 3 game running (checked when the model is
// over 1 GiB: a heavy run), 4 a scenario failed. The partial results are written either way.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PERF_LEVERS_ENV, readPerfLevers } from '../core/perf-levers.mts';
import { disposeLlama } from '../core/llama-runtime.mts';
import { resultFileName, type BenchRun, type TurnFigures } from './metrics.mts';
import { runningGames } from './guard.mts';
import { SCENARIO_A, SCENARIO_B_FILE, SCENARIO_B_MESSAGE, SCENARIO_C_MESSAGE } from './scenarios.mts';
import { defaultToolSchemas, toolDefinitionTokens } from './tool-tokens.mts';
import type { ChildConfig, ChildGroup, ChildResult } from './child.mts';

const ELECTRON = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./child.mts', import.meta.url));
const FIXTURE_B = fileURLToPath(new URL(`./fixtures/${SCENARIO_B_FILE}`, import.meta.url));
const CONTEXTS = [16384, 32768, 65536, 131072, 'max'] as const;
const GIB = 1024 ** 3;

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

/** `key=value` → [key, value]: the value read as JSON (numbers, booleans, null), else as a string. */
function leverOf(text: string): [string, unknown] {
  const at = text.indexOf('=');
  if (at <= 0) fail(2, `Levier mal écrit : ${text} (attendu clé=valeur)`);
  const raw = text.slice(at + 1);
  try { return [text.slice(0, at), JSON.parse(raw)]; } catch { return [text.slice(0, at), raw]; }
}

/** Each generation's perfLines, in order: the `[llama.cpp] llama_perf_…` lines before each `[perf]` marker. */
function perfChunks(log: string): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (line.includes('[perf] génération terminée')) { chunks.push(current); current = []; }
    else if (line.includes('[llama.cpp] llama_perf_')) current.push(line.slice(line.indexOf('[llama.cpp]')).trim());
  }
  return chunks;
}

async function gitHead(): Promise<string> {
  try {
    return (await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD'], { cwd: ELECTRON })).stdout.trim();
  } catch {
    return 'inconnu';
  }
}

function runChild(config: ChildConfig, configPath: string, logPath: string): Promise<number | null> {
  return new Promise((done, reject) => {
    void writeFile(configPath, JSON.stringify(config)).then(() => {
      const fd = openSync(logPath, 'a');
      const child = spawn(process.execPath, ['--experimental-strip-types', CHILD, configPath], { cwd: ELECTRON, stdio: ['ignore', fd, fd], windowsHide: true });
      child.once('error', error => { closeSync(fd); reject(error); });
      child.once('exit', code => { closeSync(fd); done(code); });
    }, reject);
  });
}

const { values } = parseArgs({
  options: {
    model: { type: 'string' }, label: { type: 'string' }, scenarios: { type: 'string', default: 'A,B,C' },
    context: { type: 'string', default: '32768' }, lever: { type: 'string', multiple: true, default: [] }, out: { type: 'string' },
  },
  allowPositionals: false,
});
if (!values.model || !values.label) fail(2, 'Usage : bench/run.mts --model <gguf> --label <nom> [--scenarios A,B,C] [--context 32768] [--lever clé=valeur]… [--out <dossier>]');
const scenarios = values.scenarios.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!scenarios.length || scenarios.some(s => !['A', 'B', 'C'].includes(s))) fail(2, `Scénarios inconnus : ${values.scenarios} (A, B, C)`);
const context = values.context === 'max' ? 'max' : Number(values.context);
if (!(CONTEXTS as readonly unknown[]).includes(context)) fail(2, `Contexte invalide : ${values.context} (${CONTEXTS.join(', ')})`);
const asked = Object.fromEntries(values.lever.map(leverOf));
const leversJson = JSON.stringify(asked);
// A rejected lever would silently run the shipped value: « après » would equal « avant » (ruling F24).
const { levers, rejected } = readPerfLevers({ [PERF_LEVERS_ENV]: leversJson });
if (rejected.length) fail(2, `Leviers refusés : ${rejected.join(' ; ')}`);
const model = resolve(values.model);
const modelBytes = await stat(model).then(s => s.size, () => fail(2, `Modèle introuvable : ${values.model}`));
if (modelBytes > GIB) {
  const games = await runningGames();
  if (games.length) fail(3, `Jeu en cours : ${games.join(', ')} — passage lourd refusé.`);
}

const out = resolve(values.out ?? join(ELECTRON, '..', '.superpowers', 'bench'));
await mkdir(out, { recursive: true });
const startedAt = new Date();
const fileName = resultFileName(startedAt, values.label);
const resultPath = join(out, fileName);
const logPath = join(out, fileName.replace(/\.json$/, '.log'));

// The tool definitions' cost: the default tool set, in this model's own tokens (null if the count fails).
let toolDefinitions: BenchRun['toolDefinitions'] = { chars: 0, tokens: null };
{
  const schemas = await defaultToolSchemas();
  toolDefinitions = { chars: JSON.stringify(schemas).length, tokens: null };
  try {
    toolDefinitions = { chars: toolDefinitions.chars, tokens: (await toolDefinitionTokens(model, schemas)).tokens };
  } catch (error) {
    console.warn(`[bench] jetons des outils non comptés : ${error instanceof Error ? error.message : error}`);
  } finally {
    await disposeLlama();
  }
}

const run: BenchRun = {
  schema: 1, label: values.label, startedAt: startedAt.toISOString(), gitHead: await gitHead(),
  model: { file: basename(model), bytes: modelBytes },
  machine: { cpu: os.cpus()[0]?.model.trim() ?? 'inconnu', logicalCores: os.availableParallelism(), ramBytes: os.totalmem() },
  settings: { local_context: context as number | 'max' }, levers: { ...levers },
  toolDefinitions, turns: [],
};
const failures: string[] = [];
const temp = await mkdtemp(join(os.tmpdir(), 'openagent-bench-run-'));
const session = async (name: string, config: Omit<ChildConfig, 'model' | 'context' | 'levers' | 'resultPath'>): Promise<ChildResult | null> => {
  const full: ChildConfig = { ...config, model, context: context as number | 'max', levers: leversJson, resultPath: join(temp, `${name}.result.json`) };
  console.info(`[bench] session ${name}`);
  const code = await runChild(full, join(temp, `${name}.config.json`), logPath);
  const result: ChildResult | null = await readFile(full.resultPath, 'utf8').then(JSON.parse, () => null);
  if (!result) failures.push(`${name} : aucun résultat (code ${code})`);
  else {
    run.turns.push(...result.turns);
    failures.push(...result.failures.map(f => `${name} · ${f}`));
  }
  return result;
};
try {
  if (scenarios.includes('A') || scenarios.includes('B')) {
    const groups: ChildGroup[] = [];
    if (scenarios.includes('A')) {
      const folder = join(temp, 'travail-a');
      await mkdir(folder);
      groups.push({ scenario: 'A', folder, messages: SCENARIO_A });
    }
    if (scenarios.includes('B')) {
      const folder = join(temp, 'travail-b');
      await mkdir(folder);
      await copyFile(FIXTURE_B, join(folder, SCENARIO_B_FILE));
      groups.push({ scenario: 'B', folder, messages: [SCENARIO_B_MESSAGE] });
    }
    const home = join(temp, 'home-s1');
    await mkdir(home);
    await session('S1', { home, groups, settle: [] });
  }
  if (scenarios.includes('C')) {
    const home = join(temp, 'home-c');
    const cold = join(temp, 'travail-c-froid');
    const warm = join(temp, 'travail-c-chaud');
    await Promise.all([mkdir(home), mkdir(cold), mkdir(warm)]);
    const s2 = await session('S2', { home, groups: [{ scenario: 'C-froid', folder: cold, messages: [SCENARIO_C_MESSAGE] }], settle: [] });
    // S3 restarts on S2's home: the worker re-indexes the folder it restores at start (restore_last_folder), which
    // settles before the message (F29).
    await session('S3', { home, groups: [{ scenario: 'C-chaud', folder: warm, messages: [SCENARIO_C_MESSAGE] }], settle: s2?.folders ?? [] });
  }
  if (levers.performanceTracking) {
    const chunks = perfChunks(await readFile(logPath, 'utf8').catch(() => ''));
    for (const turn of run.turns) turn.perfLines = turn.generations.flatMap(() => chunks.shift() ?? []);
  }
} catch (error) {
  failures.push(`banc interrompu : ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await writeFile(resultPath, `${JSON.stringify(run, null, 2)}\n`);
  await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(error => console.warn(`[bench] dossier temporaire laissé : ${error instanceof Error ? error.message : error}`));
}
const summary = (turn: TurnFigures) => `${turn.scenario}·${turn.message} ${turn.totalMs} ms`;
console.info(`[bench] ${fileName} : ${run.turns.map(summary).join(' · ')}`);
for (const failure of failures) console.error(`[bench] échec : ${failure}`);
process.exit(failures.length ? 4 : 0);
