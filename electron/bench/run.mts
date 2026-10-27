// The benchmark of the local LLM (plan 2026-10-25-llm-performance, Task 1): scenarios A, B and C played on the real
// worker, in fresh processes on temp data homes, and one dated results file (no path in it) per run.
//
//   node --experimental-strip-types bench/run.mts --model <gguf> --label <name> [--scenarios A,B,C] [--messages 1-4]
//        [--context 32768] [--lever key=value]… [--backend auto|cuda|vulkan|cpu] [--cuda-pack <dir>|none]
//        [--turn-timeout <minutes>] [--install-timeout <minutes>] [--touch-memory <message>] [--idle-before-send <ms>]
//        [--mcp-fake <ms>] [--setting key=value]… [--out <dir>]
//
// The 27B command of the benchmark protocol (with the user present, never while a game runs), word for word:
//
//   node --experimental-strip-types bench/guard.mts && node --experimental-strip-types bench/run.mts --model "<chemin donné par l'utilisateur>" --label 27b-t<n>-avant --context 32768 --lever outputCap=1024 --lever thoughtTokens=512 --scenarios <S> > ../.superpowers/runs/bench-27b-t<n>-avant.log 2>&1; echo exit $?
//
// The bench's own sessions (named apart from the user's measurement sessions S1, S2, S3), each a fresh process
// (bench/child.mts):
// - « session-ab »: A then B in one worker: A in an empty folder, B in a folder holding note-banc.txt;
// - « session-c-froid »: a fresh data home, one message;
// - « session-c-chaud »: a NEW process on that home (its layer-limits.v1.json kept), one message.
// The engine (I1): the spec's reference figures are CUDA. Each temp home first gets the local CUDA pack
// (`--cuda-pack`, default build/cuda-pack) through the real installer on loopback, and each session starts its worker
// as main.cjs does. A model over 1 GiB is refused unless the engine is CUDA, or `--backend` names another one.
// Every turn is bounded by `--turn-timeout` (default 15 min): past it, the worker's `stop` op ends the turn, recorded
// « stopped » and failed. The results file is rewritten after each turn and on Ctrl+C.
// Stopping (Ctrl+C) is driven from here: the first one sends the child a stop over its IPC channel — the turn ends
// through the worker's `stop` op, the worker shuts down and frees the model, the partial file is written, no further
// session starts; a second one kills the child and exits at once. A child whose parent is gone stops by itself (its
// channel closes), so an abort never leaves a model loaded. Each pack install is bounded by `--install-timeout`
// (default 10 min), then cancelled through the worker; a child that still has not exited 4 min later is killed.
// The children's output goes to `<out>/<file>.log`; each `[perf]` marker names its generation, whose perfLines it ends.
// Exit codes: 0 ok, 2 bad arguments (a rejected lever included: ruling F24), 3 game running (heavy run: the model is
// over 1 GiB, checked before each session), 4 a scenario failed. The partial results are written either way.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PERF_LEVERS_ENV, readPerfLevers, type PerfLevers } from '../core/perf-levers.mts';
import { disposeLlama } from '../core/llama-runtime.mts';
import { resultFileName, type BenchRun } from './metrics.mts';
import { runningGames } from './guard.mts';
import { SCENARIO_A, SCENARIO_B_FILE, SCENARIO_B_MESSAGE, SCENARIO_C_MESSAGE } from './scenarios.mts';
import { defaultToolSchemas, toolDefinitionTokens } from './tool-tokens.mts';
import type { Backend, ChildConfig, ChildGroup, ChildResult, SessionConfig } from './child.mts';

const ELECTRON = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./child.mts', import.meta.url));
const FIXTURE_B = fileURLToPath(new URL(`./fixtures/${SCENARIO_B_FILE}`, import.meta.url));
const DEFAULT_PACK = join(ELECTRON, 'build', 'cuda-pack');
const CONTEXTS = [16384, 32768, 65536, 131072, 'max'] as const;
const BACKENDS: readonly Backend[] = ['auto', 'cuda', 'vulkan', 'cpu'];
const GIB = 1024 ** 3;
/** Above this size the model is a real one, not the toy: B's quality then counts as a failure. */
const QUALITY_MIN_BYTES = 100 * 1024 ** 2;

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

/** Each generation's perfLines by its id: the `[llama.cpp] llama_perf_…` lines before its `[perf]` marker. */
export function perfLinesById(log: string): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  let pending: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const marker = /\[perf\] génération terminée (\S+)/.exec(line);
    if (marker) { byId.set(marker[1], pending); pending = []; }
    else if (line.includes('[llama.cpp] llama_perf_')) pending.push(line.slice(line.indexOf('[llama.cpp]')).trim());
  }
  return byId;
}

async function gitHead(): Promise<string> {
  try {
    return (await promisify(execFile)('git', ['describe', '--always', '--dirty'], { cwd: ELECTRON })).stdout.trim();
  } catch {
    return 'inconnu';
  }
}

/** Past the child's own bound (its install timeout), what it may still take to cancel and shut its worker down. */
const CHILD_GRACE_MS = 4 * 60000;

let child: ChildProcess | null = null;
/** Asks the running child to stop (its IPC channel): it ends its step and writes what it measured. */
function stopChild(): void {
  if (child?.connected) child.send({ type: 'stop' }, () => {});
}
/** Runs one child step; past `limitMs` (when given) the child is killed, and `killed` says so. A stop asked before
 * the spawn (M3) spawns nothing: `skipped`. */
function runChild(config: ChildConfig, configPath: string, logPath: string, limitMs: number | null): Promise<{ code: number | null; killed: boolean; skipped?: true }> {
  return new Promise((done, reject) => {
    void writeFile(configPath, JSON.stringify(config)).then(() => {
      if (interrupted) { done({ code: null, killed: false, skipped: true }); return; }
      const fd = openSync(logPath, 'a');
      let killed = false;
      const spawned = spawn(process.execPath, ['--experimental-strip-types', CHILD, configPath], { cwd: ELECTRON, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true });
      child = spawned;
      const limit = limitMs === null ? null : setTimeout(() => { killed = true; spawned.kill(); }, limitMs);
      spawned.once('error', error => { if (limit) clearTimeout(limit); closeSync(fd); child = null; reject(error); });
      spawned.once('exit', code => { if (limit) clearTimeout(limit); closeSync(fd); child = null; done({ code, killed }); });
    }, reject);
  });
}

let parsed: ReturnType<typeof parseOptions>;
function parseOptions() {
  return parseArgs({
    options: {
      model: { type: 'string' }, label: { type: 'string' }, scenarios: { type: 'string', default: 'A,B,C' }, messages: { type: 'string' },
      context: { type: 'string', default: '32768' }, lever: { type: 'string', multiple: true, default: [] }, out: { type: 'string' },
      backend: { type: 'string' }, 'cuda-pack': { type: 'string' }, 'turn-timeout': { type: 'string', default: '15' },
      'install-timeout': { type: 'string', default: '10' }, 'touch-memory': { type: 'string' },
      'idle-before-send': { type: 'string' }, 'mcp-fake': { type: 'string' },
      setting: { type: 'string', multiple: true, default: [] },
    },
    allowPositionals: false,
  });
}
try { parsed = parseOptions(); } catch (error) { fail(2, error instanceof Error ? error.message : String(error)); }
const { values } = parsed;
if (!values.model || !values.label) fail(2, 'Usage : bench/run.mts --model <gguf> --label <nom> [--scenarios A,B,C] [--messages 1-4] [--context 32768] [--lever clé=valeur]… [--backend auto|cuda|vulkan|cpu] [--cuda-pack <dossier>|none] [--turn-timeout <minutes>] [--install-timeout <minutes>] [--touch-memory <message>] [--idle-before-send <ms>] [--mcp-fake <ms>] [--setting clé=valeur]… [--out <dossier>]');
const scenarios = values.scenarios.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if (!scenarios.length || scenarios.some(s => !['A', 'B', 'C'].includes(s))) fail(2, `Scénarios inconnus : ${values.scenarios} (A, B, C)`);
// `--messages n`: A plays its first n messages only (the scenario subset a lever targets, e.g. A·1–A·3).
const messageCount = values.messages === undefined ? SCENARIO_A.length : Number(values.messages);
if (!Number.isInteger(messageCount) || messageCount < 1 || messageCount > SCENARIO_A.length) fail(2, `--messages invalide : ${values.messages} (1 à ${SCENARIO_A.length})`);
// `--touch-memory n` (Task 4): a line appended to A's project memory before message n (2 to the last played), as a
// save_memory would: what the context placement lever is measured on.
const touchMemory = values['touch-memory'] === undefined ? null : Number(values['touch-memory']);
if (touchMemory !== null && (!scenarios.includes('A') || !Number.isInteger(touchMemory) || touchMemory < 2 || touchMemory > messageCount)) fail(2, `--touch-memory invalide : ${values['touch-memory']} (un message de A, 2 à ${messageCount})`);
// `--idle-before-send ms` (Task 7): each session starts as the app does when the user waits that long after its start
// before writing — no hardware-info first, the model made active before the worker starts (bench/child.mts).
// `--mcp-fake ms` (Task 7, ruling F13): a global MCP server answering its initialize after that long, in each home.
const msOption = (name: 'idle-before-send' | 'mcp-fake') => {
  const raw = values[name];
  if (raw === undefined) return null;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0) fail(2, `--${name} invalide : ${raw} (millisecondes, un entier positif ou nul)`);
  return ms;
};
const idleBeforeSendMs = msOption('idle-before-send');
const mcpFakeMs = msOption('mcp-fake');
const context = values.context === 'max' ? 'max' : Number(values.context);
if (!(CONTEXTS as readonly unknown[]).includes(context)) fail(2, `Contexte invalide : ${values.context} (${CONTEXTS.join(', ')})`);
const explicitBackend = values.backend as Backend | undefined;
if (explicitBackend !== undefined && !BACKENDS.includes(explicitBackend)) fail(2, `Moteur invalide : ${values.backend} (${BACKENDS.join(', ')})`);
const turnTimeoutMs = Math.round(Number(values['turn-timeout']) * 60000);
if (!(turnTimeoutMs > 0)) fail(2, `--turn-timeout invalide : ${values['turn-timeout']} (minutes)`);
const installTimeoutMs = Math.round(Number(values['install-timeout']) * 60000);
if (!(installTimeoutMs > 0)) fail(2, `--install-timeout invalide : ${values['install-timeout']} (minutes)`);
const askedLevers = Object.fromEntries(values.lever.map(leverOf));
// `--setting key=value` (Task 9, ruling F20): a global setting saved in each session's home through
// save-global-settings, as Réglages saves it (e.g. max_thought_tokens=512); the worker refuses an invalid one. The model
// and its context stay --model and --context.
const askedSettings: Record<string, unknown> = Object.fromEntries(values.setting.map(leverOf));
for (const key of ['active_local_model', 'local_context']) if (Object.hasOwn(askedSettings, key)) fail(2, `--setting ${key} refusé : utilise ${key === 'local_context' ? '--context' : '--model'}`);
const leversJson = JSON.stringify(askedLevers);
// A rejected lever would silently run the shipped value: « après » would equal « avant » (ruling F24).
const { levers, rejected } = readPerfLevers({ [PERF_LEVERS_ENV]: leversJson });
if (rejected.length) fail(2, `Leviers refusés : ${rejected.join(' ; ')}`);
const model = resolve(values.model);
const modelBytes = await stat(model).then(s => s.size, () => fail(2, `Modèle introuvable : ${values.model}`));
const heavy = modelBytes > GIB;
const backend: Backend = explicitBackend ?? 'auto';
const packOption = values['cuda-pack'] ?? (existsSync(join(DEFAULT_PACK, 'manifest.json')) ? DEFAULT_PACK : 'none');
const packDir = packOption === 'none' || backend === 'vulkan' || backend === 'cpu' ? null : resolve(packOption);
if (packDir && !existsSync(join(packDir, 'manifest.json'))) fail(2, `Pack CUDA introuvable : ${packOption} (attendu : son manifest.json ; « none » pour s'en passer)`);
// A heavy run off CUDA would not match the reference figures: refused unless the engine was named explicitly.
const requireBackend: SessionConfig['requireBackend'] = explicitBackend && explicitBackend !== 'auto' ? explicitBackend : heavy ? 'cuda' : null;
if (heavy && requireBackend === 'cuda' && !packDir) fail(2, 'Modèle de plus de 1 Gio sans pack CUDA : les mesures de référence sont sur CUDA. Donne --cuda-pack, ou --backend pour un autre moteur.');
const guard = async () => {
  if (!heavy) return;
  const games = await runningGames();
  if (games.length) fail(3, `Jeu en cours : ${games.join(', ')} — passage lourd refusé.`);
};
await guard();

const out = resolve(values.out ?? join(ELECTRON, '..', '.superpowers', 'bench'));
await mkdir(out, { recursive: true });
const startedAt = new Date();
const fileName = resultFileName(startedAt, values.label);
const resultPath = join(out, fileName);
const logPath = join(out, fileName.replace(/\.json$/, '.log'));
const temp = await mkdtemp(join(os.tmpdir(), 'openagent-bench-run-'));

const nodeLlamaCpp = await readFile(join(ELECTRON, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8').then(text => String(JSON.parse(text).version), () => 'inconnu');
const run: BenchRun = {
  schema: 1, label: values.label, startedAt: startedAt.toISOString(), gitHead: await gitHead(),
  model: { file: basename(model), bytes: modelBytes },
  machine: { cpu: os.cpus()[0]?.model.trim() ?? 'inconnu', logicalCores: os.availableParallelism(), ramBytes: os.totalmem() },
  settings: { ...askedSettings, local_context: context as number | 'max' }, levers: { ...levers }, askedLevers: { ...levers },
  toolDefinitions: { chars: 0, tokens: null }, turns: [],
  backend: null, nodeLlamaCpp, qualityGate: modelBytes > QUALITY_MIN_BYTES, failures: [],
  ...(touchMemory === null ? {} : { touchMemory }),
  ...(idleBeforeSendMs === null ? {} : { idleBeforeSendMs }),
  ...(mcpFakeMs === null ? {} : { mcpFakeMs }),
};
const failures: string[] = [];
/** Folders a failure message may name, longest first: replaced by a placeholder, never written. */
const hidden: [string, string][] = ([[model, '<modèle>'], [temp, '<temp>'], [out, '<sortie>'], [os.tmpdir(), '<temp>'], [os.homedir(), '<dossier perso>']] as [string, string][])
  .sort((a, b) => b[0].length - a[0].length);
const withoutPaths = (text: string) => hidden.reduce((acc, [path, label]) => {
  let next = acc;
  for (const form of new Set([path, path.replaceAll('\\', '/')])) next = next.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), label);
  return next;
}, text);
/** The turns of the sessions already ended, and those of the one in progress (its partial results file). */
const ended: BenchRun['turns'] = [];
let partialPath: string | null = null;
/** The writes of the results file, one after the other (M4: a second Ctrl+C writes while the main flow may too); each
 * goes to a temp file renamed over the results, so a reader never sees half a file. */
let writing: Promise<void> = Promise.resolve();
function writeResults(): Promise<void> {
  const next = writing.then(writeResultsNow, writeResultsNow);
  writing = next.catch(() => {});
  return next;
}
async function writeResultsNow(): Promise<void> {
  const partial: ChildResult | null = partialPath ? await readFile(partialPath, 'utf8').then(text => JSON.parse(text) as ChildResult, () => null) : null;
  run.turns = [...ended, ...(partial?.turns ?? [])];
  const backends = [...new Set(run.turns.map(turn => turn.placement?.backend).filter((b): b is string => Boolean(b)))];
  run.backend = backends.length ? backends.join(', ') : null;
  run.failures = [...failures, ...(partial?.failures ?? [])].map(withoutPaths);
  await writeFile(`${resultPath}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  await rename(`${resultPath}.tmp`, resultPath);
}

let interrupted = false;
process.on('SIGINT', () => {
  // The first Ctrl+C asks the child to stop (IPC): its turn ends, its worker frees the model, it writes what it
  // measured. A second one does not wait: the child is killed (its process, so the model with it), then the file.
  if (interrupted) {
    child?.kill();
    failures.push('banc interrompu (Ctrl+C), session tuée');
    void writeResults().finally(() => process.exit(130));
    return;
  }
  interrupted = true;
  stopChild();
  console.error('[bench] interrompu : la session en cours s\'arrête, le fichier partiel suit (Ctrl+C encore pour tuer la session)');
});

async function step(name: string, config: ChildConfig): Promise<ChildResult | null> {
  if (interrupted) return null;
  console.info(`[bench] ${name}`);
  partialPath = config.resultPath;
  let code: number | null = null;
  const limitMs = config.kind === 'install' ? config.timeoutMs + CHILD_GRACE_MS : null;
  try {
    const exit = await runChild(config, join(temp, `${name}.config.json`), logPath, limitMs);
    if (exit.skipped) { partialPath = null; return null; }
    code = exit.code;
    if (exit.killed) failures.push(`${name} : processus tué après ${Math.round(limitMs! / 60000)} min`);
  } catch (error) {
    failures.push(`${name} : processus non lancé — ${error instanceof Error ? error.message : String(error)}`);
  }
  const result: ChildResult | null = await readFile(config.resultPath, 'utf8').then(text => JSON.parse(text) as ChildResult, () => null);
  partialPath = null;
  if (!result) failures.push(`${name} : aucun résultat (code ${code})`);
  else {
    ended.push(...result.turns);
    failures.push(...result.failures.map(f => `${name} · ${f}`));
  }
  await writeResults();
  return result;
}

/** A fresh temp home, with the CUDA pack installed when one is used. */
async function home(name: string): Promise<string> {
  const dir = join(temp, name);
  await mkdir(dir);
  if (packDir && !interrupted) await step(`installation-pack-${name}`, { kind: 'install', home: dir, packDir, timeoutMs: installTimeoutMs, resultPath: join(temp, `installation-${name}.result.json`) });
  return dir;
}

let applied: Readonly<PerfLevers> | null = null;
async function session(name: string, config: Omit<SessionConfig, 'kind' | 'model' | 'context' | 'levers' | 'backend' | 'requireBackend' | 'qualityGate' | 'turnTimeoutMs' | 'resultPath' | 'idleBeforeSendMs' | 'mcpFakeMs' | 'settings'>): Promise<ChildResult | null> {
  if (interrupted) return null;
  await guard();
  // A Ctrl+C during the guard (M3): no session starts (step and runChild check again before the spawn).
  if (interrupted) return null;
  const result = await step(name, {
    ...config, kind: 'session', model, context: context as number | 'max', levers: leversJson, backend, requireBackend,
    qualityGate: run.qualityGate ?? false, turnTimeoutMs, resultPath: join(temp, `${name}.result.json`), idleBeforeSendMs, mcpFakeMs,
    settings: askedSettings,
  });
  if (result?.levers && !applied) applied = result.levers;
  return result;
}

try {
  try {
    // Counted under the levers asked for the run (this process's own are the shipped ones): slimToolDefinitions changes them.
    const schemas = await defaultToolSchemas(levers.slimToolDefinitions);
    run.toolDefinitions = { chars: JSON.stringify(schemas).length, tokens: null };
    run.toolDefinitions.tokens = (await toolDefinitionTokens(model, schemas, levers.slimToolDefinitions)).tokens;
  } catch (error) {
    console.warn(`[bench] jetons des outils non comptés : ${error instanceof Error ? error.message : error}`);
  } finally {
    await disposeLlama();
  }
  if (scenarios.includes('A') || scenarios.includes('B')) {
    const groups: ChildGroup[] = [];
    if (scenarios.includes('A')) {
      const folder = join(temp, 'travail-a');
      await mkdir(folder);
      groups.push({ scenario: 'A', folder, messages: SCENARIO_A.slice(0, messageCount) });
    }
    if (scenarios.includes('B')) {
      const folder = join(temp, 'travail-b');
      await mkdir(folder);
      await copyFile(FIXTURE_B, join(folder, SCENARIO_B_FILE));
      groups.push({ scenario: 'B', folder, messages: [SCENARIO_B_MESSAGE] });
    }
    await session('session-ab', { home: await home('home-ab'), groups, settle: [], touchMemoryBefore: touchMemory });
  }
  if (scenarios.includes('C') && !interrupted) {
    const dir = await home('home-c');
    const cold = join(temp, 'travail-c-froid');
    const warm = join(temp, 'travail-c-chaud');
    await Promise.all([mkdir(cold), mkdir(warm)]);
    const first = await session('session-c-froid', { home: dir, groups: [{ scenario: 'C-froid', folder: cold, messages: [SCENARIO_C_MESSAGE] }], settle: [] });
    // A restart on the same home: the worker re-indexes the folder it restores at start (restore_last_folder), which
    // settles before the message (F29).
    await session('session-c-chaud', { home: dir, groups: [{ scenario: 'C-chaud', folder: warm, messages: [SCENARIO_C_MESSAGE] }], settle: first?.folders ?? [] });
  }
  // The levers the workers applied (M8); a difference from the ones asked means the run did not measure what it says.
  const appliedNow = applied as Readonly<PerfLevers> | null;
  if (appliedNow) {
    run.levers = { ...appliedNow };
    if (JSON.stringify(appliedNow) !== JSON.stringify(levers)) failures.push(`leviers appliqués ${JSON.stringify(appliedNow)} différents de ceux demandés ${JSON.stringify(levers)}`);
  }
  if (levers.performanceTracking) {
    const byId = perfLinesById(await readFile(logPath, 'utf8').catch(() => ''));
    for (const turn of ended) turn.perfLines = turn.generations.flatMap(g => (g.generationId ? byId.get(g.generationId) ?? [] : []));
  }
  if (interrupted) failures.push('banc interrompu (Ctrl+C)');
} catch (error) {
  failures.push(`banc interrompu : ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await writeResults().catch(error => console.error(`[bench] fichier de résultats non écrit : ${error instanceof Error ? error.message : error}`));
  await rm(temp, { recursive: true, force: true, maxRetries: 5 }).catch(error => console.warn(`[bench] dossier temporaire laissé : ${error instanceof Error ? error.message : error}`));
}
console.info(`[bench] ${fileName} : ${run.turns.map(turn => `${turn.scenario}·${turn.message} ${turn.status ?? '?'} ${turn.totalMs} ms`).join(' · ')}`);
for (const failure of run.failures ?? []) console.error(`[bench] échec : ${failure}`);
process.exit(interrupted ? 130 : run.failures?.length ? 4 : 0);
