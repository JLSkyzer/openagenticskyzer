# LLM Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Measure where a local turn spends its time, then keep only the speed-ups a benchmark proves, without losing a tool, a setting or answer quality. The levers are: stop re-reading the prompt that did not change, lighter tool definitions, a faster load, faster prompt reading and writing, and less background work during a turn. The lot also adds one setting, « Longueur maximale de la réflexion », with no limit by default.

**Architecture:**
- **Benchmark first (`electron/bench/`, not packaged).**
  - `bench/run.mts` drives the real worker (`worker.mjs`) in child processes, against an isolated `OPENAGENT_HOME`. It plays scenarios A, B and C.
  - It reads the figures from the turn log, which gains a per-generation `reuse` field, `promptMs`, the load stages and the model architecture. It also samples the process memory.
  - It writes one dated JSON file per run. `bench/compare.mts` prints a before/after table.
- **Levers behind one switchboard (`core/perf-levers.mts`).**
  - Every optimisation is a named lever whose shipped default is today's behaviour. The benchmark sets levers through `OPENAGENT_PERF_LEVERS` (JSON), so « before » and « after » run on the same build.
  - **Keep** = change the shipped default. **Revert** = remove the lever's code and tests.
  - Each decision follows a measurement. Measurements on the 27B happen only with the user present.
- **Engine (`core/local-engine.mts`).**
  - The engine reports the load stages, the architecture (hybrid, recurrent, SWA, MTP weights), `promptMs` and the reuse figures.
  - It applies the levers: checkpoint options and the token predictor on `getSequence`; batch, threads and KV type on `createContext`; a numeric layer count; `budgets.thoughtTokens`; the previous thought and the last evaluation window on `generateResponse`.
- **Prompt (`core/context.mts`, `core/prompt-layout.mts`, tool modules).** The volatile project context can move after the tool block. Tool descriptions get shorter and schemas lose their noise. Every argument contract stays byte-equal.
- **Worker (`worker.mjs`).**
  - The engine can start at boot.
  - The model load can overlap the tool preparation.
  - The semantic index becomes incremental, thread-limited and paused during a turn.
  - MCP servers can stay alive.
  - The re-placement between turns weighs the cost of re-reading the cache.

**Tech Stack:**
- Electron 44, Node 24 (`--experimental-strip-types`, `node:test`, `worker_threads`), React 19 + Vite renderer, TypeScript.
- node-llama-cpp **3.21.1**. Re-checked on 2026-10-25 in `electron/node_modules/node-llama-cpp/dist`:
  - `getSequence({ tokenPredictor, checkpoints: { max, interval, maxMemory } })`: `evaluator/LlamaContext/LlamaContext.d.ts:77-115`. Defaults `{ max: 32, interval: 8192, maxMemory: null }`: `LlamaContext.js:26-30`, applied at `:816-820`.
  - Interval checkpoints are taken at batch ends (`LlamaContext.js:1479-1491`). Under `maxMemory`, the oldest checkpoint is pruned first (`LlamaContextSequenceCheckpoints.js:64-80`).
  - Sequence getters: `nextTokenIndex` and `contextTokens` (`LlamaContext.d.ts:148,150`); `tokenPredictions` (`:185`); `needsCheckpoints`, `lastCheckpointIndex` and `checkpointsMemoryUsage` (`:329,333,337`).
  - The token meter counts `input` and `output` separately (`LlamaContext.js:331-332`). Reused tokens are not counted.
  - `performanceTracking` (`evaluator/LlamaContext/types.d.ts:197-201`) is needed by `printTimings()` (`LlamaContext.d.ts:124-129`). `batchSize` and `threads` are at `types.d.ts:45,69`.
  - `budgets.thoughtTokens` defaults to **75 % of the context** (50 % under 8 192), so it is not unlimited (`evaluator/LlamaChat/LlamaChat.d.ts:283-298`). `lastEvaluationContextWindow` is at `:253`, and `lastEvaluation` in the response at `:454`.
  - `JinjaTemplateChatWrapper`:
    - `joinAdjacentMessagesOfTheSameType = true` (`chatWrappers/generic/JinjaTemplateChatWrapper.js:76`), so two system items merge into one;
    - `keepOnlyLastThought` comes from the template, else `false` (`:249`).
  - `ChatModelSegment { type: 'segment', segmentType, text, ended }`: `types.d.ts:348-352`. `InputLookupTokenPredictor`: `evaluator/LlamaContext/tokenPredictors/InputLookupTokenPredictor.d.ts:14`.
  - `loadModel({ vocabOnly, useMmap, ignoreMemorySafetyChecks })`: `evaluator/LlamaModel/LlamaModel.d.ts:52,66,176`.
  - `GgufInsights.isRecurrent`, `isHybrid`, `hasMtpWeights` and `swaSize`: `gguf/insights/GgufInsights.d.ts:34-48`.
- `@huggingface/transformers` 4.3.0 accepts `session_options` (onnxruntime `SessionOptions`) on `from_pretrained`/`pipeline`: `types/models/modeling_utils.d.ts:138`.
- No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-25-llm-performance-design.md` (binding).
- Research, with every line re-checked at 87eaa75 where this plan cites it: `.superpowers/runs/perf-research-app.md`, `perf-research-nlc.md` and `perf-research-web.md`.
- Real logs: `.superpowers/runs/partB-turnlog/` (CPU, 0/66) and `partB2-turnlog/` (CUDA, 19/66). In partB2, `preparing` lasted 15 ms (no MCP server), loading 33.3 s and the first reading 4 074 tokens.

## Global Constraints

- **Tests.** « Tests réels, rouge d'abord. `OPENAGENT_HOME` isolé dans les tests. »
  - Every worker, bench and window test gets `OPENAGENT_HOME=<mkdtemp>`; `%USERPROFILE%\.openagent` is never read or written.
  - `stories260K.gguf` (`electron/tests/fixtures/`) is the real model of the automatic tests.
- **Full suite.** « La suite complète tourne seule, une fois par tâche. »
  - Run it alone: never beside `tsc`, a build, a bench or another suite (lesson 2026-10-18). Always behind the game guard:
    `node --experimental-strip-types bench/guard.mts && node --experimental-strip-types --test tests/all.mts > ../.superpowers/runs/suite-T<n>.log 2>&1; echo exit $?`
  - Then read the `# tests` / `# pass` lines from the file.
- **Window tests.** « Les tests à fenêtre tournent une seule fois chacun. »
  - No implementing task runs one. Task 15 runs each touched one ONCE, with its whole output in a file (lesson 2026-10-17).
  - A failure is reported with its log and capture, never re-run.
- **Games.** « Pas de passage lourd quand un jeu tourne : les processus de tests AxionEngine ou Unity d'autres sessions sont tolérés. »
  - Every heavy command (full suite, bench, packaging) is chained AFTER `bench/guard.mts` with `&&`, never `;` (lesson 2026-10-24).
  - When the user complains of lag, stop the run at once (user memory).
- **The 27B.** « Les passages sur le 27B se font seulement avec l'utilisateur présent. »
  - The controller runs them, never a subagent, after asking in chat. This covers bench runs and the vocab-only tool-token count.
  - The model path is the one the user types in chat for that session. It is never written to a committed file.
- **Public repository.** « Dépôt public : aucun chemin personnel. Interface en français. »
  - Results files hold the model's file name only, never a folder. Every user-facing string is French and asserted by its exact value (lesson 2026-10-06).
- **Removals.** « Aucun outil ni réglage n'est retiré. » This lot adds the setting `max_thought_tokens` and removes none. Tool slimming keeps every tool and every argument contract.
- **The lot's rule.** « Aucune optimisation n'est gardée sans mesure. » « Un levier sans gain mesuré, ou avec une régression de qualité ou de stabilité, est retiré et consigné. Aucun chiffre n'est présenté comme mesuré s'il ne l'a pas été. »
- **Commits.**
  - Stage only the task's own paths with an explicit `git add <paths>` from the repository root. Never `git add -A` and never `git add .`.
  - Never stage the user's unrelated changes:
    - `docs/superpowers/plans/2026-04-27-onboarding-auto.md` and `2026-04-27-semantic-plugins.md` (deleted in the work tree);
    - `docs/superpowers/plans/liste logique à suivre.txt`;
    - `docs/superpowers/plans/OK 2026-04-27-*.md`;
    - `docs/superpowers/plans/2026-09-14-native-desktop-gui.md` and `2026-10-01-mcp-enhancement.md`;
    - `docs/superpowers/specs/2026-09-14-*`.
  - Every message ends with the trailer paragraph `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a last `-m`. Push after each commit: `git push origin master`.
- **Line endings.** LF only. Write files with the edit tools, never with Python text mode (lesson 2026-10-23). Before each commit, `git diff --cached --name-only | xargs grep -lc $'\r'` must print nothing.
- **Packaging.** `bench/` is outside `build.files` and must stay out of `app.asar`. New engine modules live in `core/` (shipped through `core/**/*`). No new `.cjs` beside `main.cjs`.
- **Start-up side effects** (Task 7 `engineAtBoot`, Task 13 index). Before committing either, run `git grep -l "worker.mjs" -- electron/tests electron/bench` and confirm that every spawner sets `OPENAGENT_HOME` (lesson 2026-09-30).
- **Verification baselines**, all from `electron/`:
  - full suite **1079/1079**: measured at f6c1ee0. Every later commit (329b97b, 470c7b1, 87eaa75) is docs only, checked with `git diff --stat f6c1ee0 87eaa75 -- electron` (empty);
  - `npx tsc --noEmit -p tsconfig.core.json`: 5 pre-existing errors only;
  - `npx tsc --noEmit -p renderer-src/tsconfig.json`: 0;
  - `npm run renderer:build`: exit 0.
  - Each task states the suite count after it. A different count is explained against the files before moving on (lesson 2026-10-17).
  - A reverted lever removes its tests: the next count is the previous one minus those tests, stated in the revert commit.

### The benchmark protocol (every optimisation task)

1. **Hypothesis.** The task states the expected gain, its source, and which metric shows it.
2. **Before / after on stories260K** (automatic, mechanics only: the toy model proves the lever runs, not that it pays):
   `npm run bench -- --model tests/fixtures/stories260K.gguf --label t<n>-stories-avant --scenarios <S>`, then the same with `--label t<n>-stories-apres --lever <key>=<value>`.
3. **Before / after on the 27B** (with the user present):
   ```
   node --experimental-strip-types bench/guard.mts && node --experimental-strip-types bench/run.mts --model "<chemin donné par l'utilisateur>" --label 27b-t<n>-avant --context 32768 --lever outputCap=1024 --lever thoughtTokens=512 --scenarios <S> > ../.superpowers/runs/bench-27b-t<n>-avant.log 2>&1; echo exit $?
   ```
   - « Après » adds `--lever <key>=<value>`. Then run `npm run bench:compare -- <avant.json> <après.json>`.
   - The caps `outputCap=1024` and `thoughtTokens=512` keep a run bounded. They are the same on both sides and are stated in every table.
   - Several tasks' 27B steps may share one session with the user, but each decision is taken in task order, on top of the levers kept before it.
4. **Keep-or-revert rule.**
   - **Gain:**
     - a token count (evaluated tokens, tool tokens) is deterministic, so any reduction is a gain;
     - a time metric must improve by **≥ 10 % on the median** of the messages the task targets, in the same direction on each of them.
   - **No regression:**
     - full suite green;
     - scenario B keeps `quality.toolCalled === true` and `quality.sentinel === true` on the 27B;
     - every A reply is non-empty and not truncated;
     - no crash;
     - process RSS within +1 GiB of « avant ».
   - **Keep:** one commit that changes the lever's value in `SHIPPED_LEVERS`, plus a results file labelled `27b-t<n>-garde`.
   - **Revert:** `git revert --no-edit <the lever's commit>` when it applies cleanly, else remove the lever's code and tests by hand. Run the full suite, then record the figures and the reason in `tasks/todo.md` under « Mesures — vitesse du LLM local ».
   - **Without the user**, the lever stays at its shipped default, and the decision is written « en attente de mesure 27B ». It is never kept on stories260K figures alone.

## Review Focus

1. **Checkpoint memory on a hybrid model.** A lower interval multiplies checkpoints of about 149 MiB each (partB2 app log: RS buffers 112 + 37 MiB). With no cap, a long conversation could take gigabytes of RAM beside 8 GiB of mmap'd weights. Expected: an interval below 8 192 always comes with a memory cap. Pinned by Task 3, `perf-levers` « refuses an interval below 8192 without checkpointMaxMemory ».
2. **The project context moved after the tools.** It must still reach the model, once, and never land in the saved transcript or shift what edit and regenerate cut. Expected: the rendered prompt holds it once, and the saved messages are unchanged. Pinned by Task 4, `prompt-layout` « the context reaches the rendered prompt once, after the tools » and `agent` « the saved transcript has no context item ».
3. **A kept-alive MCP server after trust withdrawal, removal or a config change.** It must stop, and never serve another project or an old config. Pinned by Task 14, `mcp-client` « closeWhere kills the process » and `worker-mcp` « mcp-remove and trust withdrawal stop the kept server ».
4. **Quitting while the engine starts at boot.** A quit during `getLlama`'s binary test is a native call (the lesson 2026-10-24 crash class, 0xC0000409). Expected: shutdown waits for the start and the process ends cleanly. Pinned by Task 7, `worker-engine-start` « shutdown right after start with engineAtBoot ends cleanly ».
5. **A turn that stops or fails while the index is paused.** The pause must lift in every case, or the index never finishes. Pinned by Task 13, `worker-index-status` « a stopped turn resumes the indexing ».

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `electron/core/perf-levers.mts` | **create** (T1), grows (T3–T14) | `PerfLevers`, `SHIPPED_LEVERS`, `readPerfLevers`, `perfLevers` |
| `electron/core/reuse.mts` | **create** (T1) | pure: `ReuseFigures`, `commonPrefixLength`, `reuseOf` |
| `electron/core/builtin-tools.mts` | **create** (T1) | `builtInTools` moved out of `worker.mjs`, shared with the bench |
| `electron/core/model-types.mts` | modify (T1) | `LoadStage`, `ModelArchitecture`, `GenerationStats.promptMs/reuse/predictions` |
| `electron/core/local-engine.mts` | modify (T1, T3, T5, T8, T9, T10, T11, T12) | stages, reuse, levers, budgets |
| `electron/core/llama-runtime.mts` | modify (T1) | `llamaLogger` forwards `llama_perf` lines when tracking |
| `electron/core/turn-log.mts` | modify (T1) | `model-ready.loadStages/architecture`, `generation.promptMs/reuse/predictions` |
| `electron/core/agent.mts` | modify (T1, T4) | `toolSchemas` (T1); `projectContext` (T4) |
| `electron/core/prompt-layout.mts` | **create** (T4) | `toolsAfterSystem`, `contextItem` |
| `electron/core/context.mts` | modify (T4) | returns `base` and `projectContext` apart |
| `electron/core/local-provider.mts` | modify (T4, T5, T6) | context item, thought segment, `compactSchema` |
| `electron/core/request-context.mts` | modify (T5) | `keepThought` option |
| tool modules `workspace`, `git-tools`, `memory-tools`, `project-analyzer`, `shell-tool`, `web-tools`, `search-tools` (`.mts`) | modify (T6) | shorter descriptions, same contracts |
| `electron/core/settings.mts` | modify (T9) | `max_thought_tokens: null` and its rule |
| `electron/core/semantic-index.mts`, `embeddings.mts`, `json-store.mts` | modify (T13) | incremental, thread limit, compact JSON, gate |
| `electron/core/index-gate.mts` | **create** (T13) | `IndexGate` |
| `electron/core/mcp-client.mts` | modify (T14) | `McpPool` |
| `electron/worker.mjs` | modify (T1, T4, T7, T9, T12, T13, T14) | wiring |
| `renderer-src/src/components/settings/hardware-view.ts`, `HardwareTab.tsx` | modify (T9) | « Longueur maximale de la réflexion » |
| `electron/bench/{guard,scenarios,metrics,memory,child,run,compare,tool-tokens}.mts`, `bench/fixtures/note-banc.txt` | **create** (T1) | the benchmark |
| `electron/bench/reuse-report.mts` | **create** (T2) | reuse verdicts |
| `electron/package.json` | modify (T1, T2) | scripts `bench`, `bench:compare`, `bench:tools`, `bench:guard` (T1), `bench:reuse` (T2) |
| tests, **create** | | `reuse`, `perf-levers`, `bench-metrics`, `bench` (T1); `prompt-layout` (T4); `tool-contracts` + `fixtures/tool-contracts.v1.json` (T6) |
| tests, modify | | `local-engine`, `worker-turn-log` (T1); `bench-metrics` (T2); `perf-levers` (T3, T5, T7–T14); `local-provider`, `agent`, `worker-tools` (T4–T6); `worker-engine-start` (T7); `low-vram-fallback` (T8); `local-context`, `hardware-view` (T9); `local-engine` (T10, T11); `replacement` (T12); `semantic-index`, `embeddings`, `worker-index-status` (T13); `mcp-client`, `worker-mcp` (T14); `all.mts` |
| window test | modify (T9), run in T15 | `hardware-visual.cjs` |
| `tasks/todo.md`, `tasks/lessons.md`, `README.md`, this plan | modify (T2…T15) | measurements, bilan, lessons |

---

## Task 1: The benchmark — scenarios A, B, C, per-turn figures, the `reuse` field, results files and compare

**Files:**
- Create:
  - `electron/core/perf-levers.mts`, `electron/core/reuse.mts`, `electron/core/builtin-tools.mts`;
  - `electron/bench/guard.mts`, `scenarios.mts`, `metrics.mts`, `memory.mts`, `child.mts`, `run.mts`, `compare.mts`, `tool-tokens.mts`, `fixtures/note-banc.txt`;
  - `electron/tests/reuse.test.mts`, `perf-levers.test.mts`, `bench-metrics.test.mts`, `bench.test.mts`.
- Modify:
  - `electron/core/model-types.mts` (`LoadEvent`, `GenerationStats`: lines 32-38);
  - `electron/core/local-engine.mts` (`loadFresh` 334-411, `keep` 413-430, `completeLocal` 641-676, `LOCAL_OUTPUT_CAP` 592, `localProvider` 681-691);
  - `electron/core/llama-runtime.mts` (`llamaLogger` 132-138);
  - `electron/core/turn-log.mts` (`TurnLogEvent` 142-149);
  - `electron/core/agent.mts` (schemas 78-80 → `toolSchemas`);
  - `electron/worker.mjs` (`builtInTools` 336-347 → import; the `generation` log 768; `logModelReady` 244-272 and the `onLoad` `end` branch);
  - `electron/tests/local-engine.test.mts`, `electron/tests/worker-turn-log.test.mts`, `electron/tests/all.mts`, `electron/package.json` (scripts).

**Interfaces:**
- Produces `core/perf-levers.mts`:
  ```ts
  export interface PerfLevers {
    outputCap: number;              // shipped 8192 (= LOCAL_OUTPUT_CAP)
    thoughtTokens: number | null;   // shipped null: no bench cap (the setting decides, T9)
    performanceTracking: boolean;   // shipped false
  }                                 // later tasks add their keys, each shipped at today's behaviour
  export const PERF_LEVERS_ENV = 'OPENAGENT_PERF_LEVERS';
  export const SHIPPED_LEVERS: Readonly<PerfLevers>;
  export function readPerfLevers(env?: NodeJS.ProcessEnv): { levers: Readonly<PerfLevers>; rejected: string[] };
  // env[PERF_LEVERS_ENV] is a JSON object; an unknown key, a wrong type or invalid JSON goes to `rejected`
  // (`clé inconnue : x`, `valeur invalide : outputCap`, `JSON invalide`) and the shipped value stays
  export function perfLevers(): Readonly<PerfLevers>;   // readPerfLevers(process.env) once per thread; each rejection console.warn'ed once as `[levers] ${r}`
  ```
- Produces `core/reuse.mts` (pure):
  ```ts
  export interface CheckpointFigures { needed: boolean; memoryBytes: number; lastIndex: number }
  export interface ReuseFigures {
    held: number;      // tokens the sequence held before the call
    common: number;    // common prefix of the held tokens and the tokens after the call: where the new prompt diverged
    prompt: number;    // ≈ prompt length: max(evaluated, after.length − outputTokens)
    evaluated: number; // input tokens actually evaluated (tokenMeter diff)
    reused: number;    // max(0, prompt − evaluated)
    checkpoints: CheckpointFigures | null;   // null when the sequence needs none
  }
  export function commonPrefixLength(a: readonly number[], b: readonly number[]): number;
  export function reuseOf(p: { heldTokens: readonly number[]; afterTokens: readonly number[]; evaluated: number; outputTokens: number; checkpoints: CheckpointFigures | null }): ReuseFigures;
  ```
- Produces `core/model-types.mts` (additions):
  ```ts
  export interface LoadStage { stage: 'engine' | 'precheck' | 'loadModel' | 'createContext' | 'chat'; ms: number; ok: boolean; gpuLayers?: number }
  export interface ModelArchitecture { hybrid: boolean; recurrent: boolean; swaSize: number | null; mtpWeights: boolean }
  // LoadEvent 'end' gains: stages: LoadStage[]; architecture: ModelArchitecture
  // GenerationStats gains: promptMs: number | null   (call start → first chunk carrying tokens; null when none came)
  //                        reuse?: ReuseFigures
  ```
- Produces `core/builtin-tools.mts`: `export async function builtInTools(folder: string, dataHome: string, ignoredPatterns: string): Promise<AgentTool[]>`. The same seven modules in the same order as `worker.mjs:336-347`. `worker.mjs` imports it at its three call sites.
- Produces `core/agent.mts`: `export function toolSchemas(tools: readonly AgentTool[], settings: AgentSettings): ToolSchema[]`. It is the existing mapping at 78-80, and `runAgent` uses it.
- `core/turn-log.mts` `TurnLogEvent`:
  - `model-ready` gains `loadStages?: LoadStage[]` and `architecture?: ModelArchitecture`;
  - `generation` gains `promptMs?: number | null` and `reuse?: ReuseFigures`.
  - These are figures, kept at the `metadata` level too.
- `core/local-engine.mts`:
  - `completeLocal` uses `perfLevers().outputCap` instead of `LOCAL_OUTPUT_CAP`, which stays exported at 8192, as does `localProvider(...).outputCap`.
  - It passes `budgets: { thoughtTokens: levers.thoughtTokens ?? Infinity }` (T9 adds the setting in between).
  - With `performanceTracking`, `createContext` gets `performanceTracking: true`. After each generation it does `await context.printTimings()`, then `console.info('[perf] génération terminée')`.
  - `llamaLogger` forwards info lines matching `/^llama_perf_/` as `[llama.cpp] …` only when `perfLevers().performanceTracking`.
- Produces `bench/` (Node CLIs, `node --experimental-strip-types`):
  ```ts
  // guard.mts
  export const GAME_PROCESSES: readonly string[];   // ['javaw.exe', 'Minecraft.exe', 'MinecraftLauncher.exe']
  export function gamesIn(tasklistCsv: string): string[];   // `tasklist /v /fo csv` rows: image in GAME_PROCESSES (case-insensitive)
                                                            // or a window title matching /minecraft/i; Unity.exe and AxionEngine* never count
  export async function runningGames(): Promise<string[]>;  // [] outside win32
  // run directly: exit 1 printing `Jeu en cours : ${names.join(', ')} — passage lourd refusé.`, else exit 0
  // scenarios.mts
  export const SCENARIO_A: readonly string[];  // exactly 4 messages, see Step 3
  export const SCENARIO_B_FILE = 'note-banc.txt';
  export const SCENARIO_B_SENTINEL = 'HÉRON-42';
  export const SCENARIO_B_MESSAGE: string;
  export const SCENARIO_C_MESSAGE: string;
  // metrics.mts (pure)
  export type PhaseName = 'preparing' | 'loading' | 'reading' | 'thinking' | 'writing' | 'tool';
  export interface GenerationFigures { step: number; inputTokens: number; outputTokens: number; generationMs: number; promptMs: number | null; tokensPerSecond: number | null; reuse: ReuseFigures | null }
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
  export function turnFigures(lines: readonly Record<string, unknown>[], meta: { scenario: TurnFigures['scenario']; message: number; memory: MemorySample; placement: TurnFigures['placement']; perfLines: string[] }): TurnFigures;
  // phasesMs sums each `phase` line's previousMs under `previous`, plus the last phase up to the `end` line's `at`;
  // tokensPerSecond = outputTokens / (generationMs / 1000), null when generationMs is 0
  export interface ComparisonRow { key: string; metric: string; before: number | null; after: number | null; changePercent: number | null }
  export function compareRuns(before: BenchRun, after: BenchRun): ComparisonRow[];  // key `${scenario}·${message}`; metrics: lecture (ms), jetons évalués,
                                                                                     // jetons réutilisés, tok/s, chargement (ms), RSS (Mio)
  export function formatComparison(rows: readonly ComparisonRow[]): string;  // Markdown table, header `| Tour | Mesure | Avant | Après | Écart |`
  export function resultFileName(at: Date, label: string): string;            // `YYYYMMDD-HHmmss-<label>.json`, local time, label reduced to [a-z0-9-]
  // memory.mts
  export function parseGpuCounters(typeperfCsv: string): { dedicated: number | null; shared: number | null };
  export async function sampleMemory(pid?: number): Promise<MemorySample>;  // rss from process.memoryUsage(); GPU from
  // `typeperf "\GPU Process Memory(pid_<pid>*)\Dedicated Usage" "\GPU Process Memory(pid_<pid>*)\Shared Usage" -sc 1` (10 s cap), null off win32 or on failure
  // tool-tokens.mts
  export async function toolDefinitionTokens(modelPath: string, tools: readonly ToolSchema[]): Promise<{ chars: number; tokens: number; perTool: { name: string; chars: number }[] }>;
  // a vocabOnly load; the model's own chat wrapper renders [system 'x', user 'y'] with and without `availableFunctions`;
  // tokens = the difference of the two token counts; chars = JSON.stringify(tools).length
  ```
- CLI `bench/run.mts --model <gguf> --label <name> [--scenarios A,B,C] [--context 32768] [--lever key=value]… [--out <dir>]`:
  - Default `--out` is `<repo>/.superpowers/bench/`, which `.superpowers/` in `.gitignore` already ignores (check with `git check-ignore`).
  - Exit codes: 0 ok, 2 bad arguments, 3 game running (the guard runs inside when the model file is over 1 GiB: a heavy run), 4 a scenario failed. The partial results are written either way.
  - Sessions, each a fresh process (`child.mts`, one temp `OPENAGENT_HOME` and temp work folders, all removed at the end):
    - **S1** = A then B in one worker. A runs in folder 1 (empty). B runs in folder 2, holding `note-banc.txt`.
    - **S2** = « C-froid »: fresh home, one message.
    - **S3** = « C-chaud »: a NEW process on S2's home, which keeps `layer-limits.v1.json`, one message.
  - Each child:
    - sets `OPENAGENT_HOME` and `OPENAGENT_PERF_LEVERS`;
    - adds the model to the library (`gguf-add`) and sets `active_local_model` and `local_context`;
    - calls `activate_folder` as the app does, then `send` per message, waiting for the terminal event;
    - reads its turn log lines (`<home>/logs/turns/*.jsonl`, by `runId`), `model-status`'s placement and `sampleMemory()`;
    - ends the worker with the `shutdown` op, never `terminate()` (lesson 2026-10-24).
  - The child's stdout and stderr go to `<out>/<file>.log` beside the results; `perfLines` are cut from it at the `[perf]` markers.
- CLI `bench/compare.mts <avant.json> <après.json>` prints `formatComparison(compareRuns(...))`.
- CLI `bench/tool-tokens.mts --model <gguf>` prints `{ chars, tokens, perTool }` for the default tool set: built-ins in an empty temp folder, `agent_mode` auto, `permission_mode` demander.
- `package.json` scripts:
  - `"bench": "node --experimental-strip-types bench/run.mts"`;
  - `"bench:compare": "node --experimental-strip-types bench/compare.mts"`;
  - `"bench:tools": "node --experimental-strip-types bench/tool-tokens.mts"`;
  - `"bench:guard": "node --experimental-strip-types bench/guard.mts"`.

**Steps:**
- [ ] **Step 1: Write the failing unit tests.** `tests/reuse.test.mts`:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { commonPrefixLength, reuseOf } from '../core/reuse.mts';

  test('reuseOf: an attention model keeps the common prefix — reused equals the prompt minus what was evaluated', () => {
    const held = [1, 2, 3, 4, 5, 6, 7, 8];          // previous prompt 1..6 + reply 7, 8
    const after = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]; // new prompt 1..6, 9, 10 + 2 generated
    const r = reuseOf({ heldTokens: held, afterTokens: after, evaluated: 2, outputTokens: 2, checkpoints: null });
    assert.deepEqual(r, { held: 8, common: 6, prompt: 8, evaluated: 2, reused: 6, checkpoints: null });
  });
  test('reuseOf: a hybrid model without a usable checkpoint matched 6 tokens but re-read all 8', () => {
    const r = reuseOf({ heldTokens: [1, 2, 3, 4, 5, 6, 7, 8], afterTokens: [1, 2, 3, 4, 5, 6, 9, 10, 11, 12], evaluated: 8, outputTokens: 2,
      checkpoints: { needed: true, memoryBytes: 156237824, lastIndex: 7 } });
    assert.equal(r.common, 6);
    assert.equal(r.reused, 0);
    assert.equal(r.checkpoints?.needed, true);
  });
  test('commonPrefixLength and a cold call: nothing held, nothing reused', () => {
    assert.equal(commonPrefixLength([], [1, 2]), 0);
    assert.equal(commonPrefixLength([1, 2, 3], [1, 2, 4]), 2);
    assert.deepEqual(reuseOf({ heldTokens: [], afterTokens: [1, 2, 3, 4], evaluated: 3, outputTokens: 1, checkpoints: null }),
      { held: 0, common: 0, prompt: 3, evaluated: 3, reused: 0, checkpoints: null });
  });
  ```
  `tests/perf-levers.test.mts`:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { readPerfLevers, SHIPPED_LEVERS, PERF_LEVERS_ENV } from '../core/perf-levers.mts';
  import { LOCAL_OUTPUT_CAP } from '../core/local-engine.mts';

  test('perfLevers: no variable = the shipped levers (today\'s behaviour); a valid key overrides; anything else is rejected and named', () => {
    assert.deepEqual(readPerfLevers({}), { levers: SHIPPED_LEVERS, rejected: [] });
    assert.equal(SHIPPED_LEVERS.outputCap, LOCAL_OUTPUT_CAP);
    assert.equal(SHIPPED_LEVERS.thoughtTokens, null);
    const { levers, rejected } = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ outputCap: 64, nope: 1, thoughtTokens: -3 }) });
    assert.equal(levers.outputCap, 64);
    assert.equal(levers.thoughtTokens, null);
    assert.deepEqual(rejected, ['clé inconnue : nope', 'valeur invalide : thoughtTokens']);
    assert.deepEqual(readPerfLevers({ [PERF_LEVERS_ENV]: '{' }).rejected, ['JSON invalide']);
  });
  ```
  `tests/bench-metrics.test.mts`:
  ```ts
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
  ```
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/reuse.test.mts tests/perf-levers.test.mts tests/bench-metrics.test.mts`. Expect FAIL: `Cannot find module '../core/reuse.mts'` (and the same for the others).
- [ ] **Step 3: Implement** `core/reuse.mts`, `core/perf-levers.mts`, `bench/guard.mts`, `bench/metrics.mts` and `bench/scenarios.mts`, per the Interfaces.
  - The scenario texts are exact copy. A: `['Bonjour. En une phrase : à quoi sert un fichier README ?', 'Et un fichier LICENSE ? Une phrase.', 'Cite une licence libre, en un mot.', 'Merci. Résume notre échange en une phrase.']`.
  - B: `Lis le fichier note-banc.txt avec read_file, puis donne-moi le nom de code qu'il contient.`
  - C: `Bonjour. Réponds en une phrase : qu'est-ce qu'un fichier README ?`
  - `bench/fixtures/note-banc.txt`: `Note du banc d'essai.\nLe nom de code du banc d'essai est HÉRON-42.\n` (LF).
- [ ] **Step 4: Run** the three files. Expect PASS (5 tests).
- [ ] **Step 5: Write the failing engine and log tests.**
  - `tests/local-engine.test.mts`, appended:
    ```ts
    test('f. a real load reports its stages and the model architecture; a generation reports promptMs and its reuse', { timeout: 60000 }, async t => {
      const ends: LoadEvent[] = [];
      t.after(() => disposeEngine());
      const stats: GenerationStats[] = [];
      for (const text of ['Once upon a time', 'Once upon a time there']) {
        await completeLocal({ modelPath, messages: [{ role: 'user', content: text }], maxTokens: 8, onStats: s => stats.push(s),
          onLoad: (e: LoadEvent) => { if (e.kind === 'end') ends.push(e); } });
      }
      assert.equal(ends.length, 1, 'one real load, the second call reuses the warm engine');
      const end = ends[0] as Extract<LoadEvent, { kind: 'end' }>;
      assert.deepEqual(end.stages.map(s => s.stage), ['engine', 'precheck', 'loadModel', 'createContext', 'chat']);
      assert.ok(end.stages.every(s => s.ok && s.ms >= 0));
      assert.deepEqual(end.architecture, { hybrid: false, recurrent: false, swaSize: null, mtpWeights: false });
      assert.ok(stats[0].promptMs !== null && stats[0].promptMs >= 0);
      assert.equal(stats[0].reuse?.held, 0);
      assert.ok((stats[1].reuse?.reused ?? 0) > 0, 'the second prompt starts like the first: an attention model reuses it');
    });
    ```
    The test drives the load through `completeLocal`, so `LocalCompletionOptions` gains `onLoad?: WindowOptions['onLoad']`, forwarded to `engineFor`. The file's existing `disposeEngine` between tests makes the first call a real load.
  - `tests/worker-turn-log.test.mts`, appended:
    ```ts
    test('7. two stories260K turns: each generation line carries promptMs and reuse, and the second reuses the first prompt', { timeout: 180000 }, async t => {
      const { worker, folder, home } = await setupLocal(t, { [PERF_LEVERS_ENV]: JSON.stringify({ outputCap: 16 }) });
      const rec = recordAgentEvents(worker);
      for (const text of ['Once upon a time', 'Once upon a time again']) {
        const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text });
        await rec.until(runId, { timeoutMs: 170000 });
      }
      const generations = (await dayLines(home)).filter(line => line.event === 'generation');
      assert.equal(generations.length, 2);
      for (const g of generations) assert.deepEqual(Object.keys(g.reuse).sort(), ['checkpoints', 'common', 'evaluated', 'held', 'prompt', 'reused']);
      assert.ok(generations[1].reuse.reused > 0);
      assert.equal(typeof generations[0].promptMs, 'number');
      const ready = (await dayLines(home)).find(line => line.event === 'model-ready');
      assert.equal(ready.architecture.hybrid, false);
      assert.ok(ready.loadStages.length >= 4);
    });
    ```
    `setupLocal` and `dayLines` are the file's existing stories260K setup and day-file reader, extended to take extra env.
- [ ] **Step 6: Run** both files. Expect FAIL: `end.stages` undefined, and `reuse` undefined in the log line.
- [ ] **Step 7: Implement the engine side.**
  - `loadFresh` times each stage with `performance.now()`:
    - `engine` = `runtimeLlama()`;
    - `precheck` = `assertContextCanFit` + `getVramState` + `recallLimit`;
    - one `loadModel` per attempt, with `gpuLayers`, and `ok: false` for a refused one;
    - one `createContext` per attempt;
    - `chat` = `keep()`'s `LlamaChat` creation.
  - `architecture` comes from the `insights` already read (`isHybrid`, `isRecurrent`, `swaSize ?? null`, `hasMtpWeights`). Both ride on `onLoad({ kind: 'end', … })`.
  - `completeLocal` takes `heldTokens = chat.sequence.contextTokens` before `generateResponse` and the start time. The first chunk with tokens sets `promptMs`.
  - In the `finally`, it calls `reuseOf({ heldTokens, afterTokens: chat.sequence.contextTokens, evaluated, outputTokens, checkpoints })`. `checkpoints` comes from `chat.sequence.needsCheckpoints ? { needed: true, memoryBytes: checkpointsMemoryUsage, lastIndex: lastCheckpointIndex } : null`.
  - It passes `budgets: { thoughtTokens: levers.thoughtTokens ?? Infinity }` and `maxTokens: options.maxTokens ?? levers.outputCap`.
  - With `performanceTracking`, it awaits `printTimings()` and prints the `[perf]` marker.
  - `worker.mjs`:
    - logs `promptMs` and `reuse` on the `generation` line, when present;
    - stores the `end` event's `stages` and `architecture` and passes them to `logModelReady`, which writes `loadStages` and `architecture`.
  - Move `builtInTools` to `core/builtin-tools.mts`, and add `toolSchemas` to `agent.mts`.
- [ ] **Step 8: Run** `tests/local-engine.test.mts tests/worker-turn-log.test.mts tests/agent.test.mts tests/worker-tools.test.mts`. Expect PASS.
- [ ] **Step 9: Write the failing end-to-end test** `tests/bench.test.mts`:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';
  import { mkdtemp, readdir, readFile, copyFile } from 'node:fs/promises';
  import { tmpdir, homedir } from 'node:os';
  import { join } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { removeAtEnd } from './teardown.mts';
  import { toolDefinitionTokens } from '../bench/tool-tokens.mts';
  import { builtInTools } from '../core/builtin-tools.mts';
  import { toolSchemas } from '../core/agent.mts';

  const run = promisify(execFile);
  const electron = fileURLToPath(new URL('..', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

  test('the bench plays A, B and C on stories260K and writes one dated results file, with no path in it', { timeout: 300000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-bench-'));
    removeAtEnd(t, root);
    const model = join(root, 'stories260K.gguf');
    await copyFile(fixture, model);
    await run(process.execPath, ['--experimental-strip-types', 'bench/run.mts', '--model', model, '--label', 'test', '--out', root, '--lever', 'outputCap=32'], { cwd: electron, timeout: 280000 });
    const files = (await readdir(root)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}-\d{6}-test\.json$/);
    const text = await readFile(join(root, files[0]), 'utf8');
    assert.equal(text.includes(root) || text.includes(homedir()), false, 'no folder in the results');
    const result = JSON.parse(text);
    assert.deepEqual(result.turns.map((t: any) => `${t.scenario}·${t.message}`), ['A·1', 'A·2', 'A·3', 'A·4', 'B·1', 'C-froid·1', 'C-chaud·1']);
    for (const turn of result.turns) {
      assert.ok(turn.generations.length >= 1 && turn.generations[0].outputTokens <= 32);
      assert.ok(turn.memory.rssBytes > 0);
    }
    assert.ok(result.turns[1].generations[0].reuse.reused > 0, 'A·2 reuses the prompt of A·1 (attention model)');
    assert.ok(result.turns[5].loadStages.some((s: any) => s.stage === 'engine'));
    assert.equal(result.model.file, 'stories260K.gguf');
    assert.ok(result.toolDefinitions.chars > 0);
  });

  test('toolDefinitionTokens on stories260K: the tools rendered by the model\'s own template cost tokens', { timeout: 60000 }, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'openagent-tooltokens-'));
    removeAtEnd(t, folder);
    const tools = toolSchemas(await builtInTools(folder, folder, ''), { mode: 'auto', permissions: { permission_mode: 'demander', shell_ask: true, files_ask: true, search_ask: false } } as never);
    const count = await toolDefinitionTokens(fixture, tools);
    assert.equal(count.chars, JSON.stringify(tools).length);
    assert.ok(count.tokens > 0);
    assert.equal(count.perTool.length, tools.length);
  });
  ```
  The settings object passed to `toolSchemas` is the shape `agentSettingsOf` returns. Read `worker.mjs::agentSettingsOf` before writing it, and remove the `as never` once the type matches.
- [ ] **Step 10: Run** `node --experimental-strip-types --test tests/bench.test.mts`. Expect FAIL: `bench/run.mts` not found.
- [ ] **Step 11: Implement** `bench/memory.mts`, `child.mts`, `run.mts`, `compare.mts` and `tool-tokens.mts`, plus the package scripts, per the Interfaces.
  - The header comment of `run.mts` documents the 27B command of the benchmark protocol, word for word, with « chemin donné par l'utilisateur » as the path.
  - `run.mts` records `gitHead` from `git rev-parse --short HEAD`, and `machine` from `os.cpus()[0].model`, `os.availableParallelism()` and `os.totalmem()`.
- [ ] **Step 12: Run** `tests/bench.test.mts`. Expect PASS. Then add the four new files to `tests/all.mts`: `reuse`, `perf-levers`, `bench-metrics`, `bench`.
- [ ] **Step 13: Full suite**, alone, behind the guard. Expect **1090/1090**: 1079 + 11 (reuse 3, perf-levers 1, bench-metrics 3, local-engine f 1, worker-turn-log 7 1, bench 2). Then run `npx tsc --noEmit -p tsconfig.core.json` and expect the 5 pre-existing errors only.
- [ ] **Step 14: Baseline on stories260K.**
  - Run `npm run bench -- --model tests/fixtures/stories260K.gguf --label stories-reference --lever outputCap=64`.
  - `git check-ignore -q ../.superpowers/bench/<file>` exits 0.
  - Note the file name in `tasks/todo.md`, in a new section « Mesures — vitesse du LLM local (2026-10-25) ».
- [ ] **Step 15: Commit:**
  ```
  git add electron/core/perf-levers.mts electron/core/reuse.mts electron/core/builtin-tools.mts electron/core/model-types.mts electron/core/local-engine.mts electron/core/llama-runtime.mts electron/core/turn-log.mts electron/core/agent.mts electron/worker.mjs electron/bench electron/tests/reuse.test.mts electron/tests/perf-levers.test.mts electron/tests/bench-metrics.test.mts electron/tests/bench.test.mts electron/tests/local-engine.test.mts electron/tests/worker-turn-log.test.mts electron/tests/all.mts electron/package.json tasks/todo.md
  git commit -m "test: a reproducible benchmark — scenarios A, B, C on the real worker, per-turn phases, evaluated vs reused tokens, tok/s, memory, load stages, one dated results file per run and a compare table; the turn log gains reuse and promptMs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 2: Measure the real reuse first — the 27B reference and the reuse verdicts

The spec's objective 2 starts with a measurement. No lever changes here.

**Files:**
- Create: `electron/bench/reuse-report.mts`.
- Modify: `electron/tests/bench-metrics.test.mts`, `electron/package.json` (`"bench:reuse": "node --experimental-strip-types bench/reuse-report.mts"`), `tasks/todo.md`.

**Interfaces:**
- Consumes: `BenchRun` and `ReuseFigures` (T1).
- Produces `bench/reuse-report.mts`:
  ```ts
  export const RESTORE_SLACK = 16;   // tokens: re-reading this little after the divergence still counts as reuse
  export type ReuseVerdict = 'froid' | 'réutilisé' | 'point de sauvegarde manquant';
  export function classifyReuse(r: ReuseFigures): ReuseVerdict;
  // held 0 → 'froid'; reused ≥ common − RESTORE_SLACK → 'réutilisé'; else 'point de sauvegarde manquant'
  export function divergenceAt(previous: ReuseFigures | null, current: ReuseFigures): 'dans le prompt précédent' | 'dans la réponse précédente' | null;
  // null when previous is null; common < previous.prompt → 'dans le prompt précédent'; else 'dans la réponse précédente'
  export function formatReuseReport(run: BenchRun): string;
  // one line per A/B generation: `A·2 étape 0 : tenus 4180 · communs 4091 · relus 4213 · réutilisés 0 — point de sauvegarde manquant (dans la réponse précédente)`
  ```

**Steps:**
- [ ] **Step 1: Write the failing tests**, appended to `tests/bench-metrics.test.mts`:
  ```ts
  import { classifyReuse, divergenceAt, formatReuseReport } from '../bench/reuse-report.mts';
  const fig = (held: number, common: number, prompt: number, evaluated: number) => ({ held, common, prompt, evaluated, reused: Math.max(0, prompt - evaluated), checkpoints: null });
  test('classifyReuse: cold, reused, and a hybrid checkpoint miss', () => {
    assert.equal(classifyReuse(fig(0, 0, 4074, 4074)), 'froid');
    assert.equal(classifyReuse(fig(4184, 4091, 4120, 30)), 'réutilisé');
    assert.equal(classifyReuse(fig(4184, 4091, 4120, 4120)), 'point de sauvegarde manquant');
  });
  test('divergenceAt and the report line', () => {
    assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4071, 4120, 4120)), 'dans le prompt précédent');
    assert.equal(divergenceAt(fig(0, 0, 4074, 4074), fig(4184, 4080, 4120, 4120)), 'dans la réponse précédente');
    assert.equal(divergenceAt(null, fig(0, 0, 1, 1)), null);
    // a BenchRun whose A·2 generation holds fig(4184, 4080, 4120, 4120) after A·1's fig(0, 0, 4074, 4074)
    assert.match(formatReuseReport(runOf([fig(0, 0, 4074, 4074), fig(4184, 4080, 4120, 4120)])),
      /^A·2 étape 0 : tenus 4184 · communs 4080 · relus 4120 · réutilisés 0 — point de sauvegarde manquant \(dans la réponse précédente\)$/m);
  });
  ```
  `runOf(figs)` is a local helper that builds a `BenchRun` with one A turn per figure: message `i + 1`, step 0.
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/bench-metrics.test.mts`. Expect FAIL: the module is not found.
- [ ] **Step 3: Implement** `bench/reuse-report.mts` and its CLI (`<results.json>` → stdout).
- [ ] **Step 4: Run.** Expect PASS (5 tests in the file).
- [ ] **Step 5: Full suite**, alone. Expect **1092/1092**.
- [ ] **Step 6: The 27B reference (user present; session 1).**
  - Ask the user for the model path and for a moment with no game running.
  - Run the protocol command with `--label 27b-reference` and every scenario, then `npm run bench:reuse -- <file>`.
  - Record in `tasks/todo.md`, each figure marked « mesuré »:
    - A·1 to A·4: evaluated, reused, common, `promptMs`, tok/s and checkpoint memory;
    - B: tool called, sentinel;
    - C-froid and C-chaud: `loadMs` and stages. C-chaud is also the first real proof of the remembered layer limit on the 27B, which the previous lot listed as « non prouvé »;
    - `architecture`, including `mtpWeights`;
    - `toolDefinitions` (chars, and tokens via `npm run bench:tools -- --model <27B>`).
  - **Decide the hypotheses of Tasks 3–5** from the verdicts, and write them in `tasks/todo.md`:
    - « point de sauvegarde manquant » on A·2–A·4 makes Task 3 the main lever;
    - « dans le prompt précédent » points at the system or tool part, so Task 4;
    - « dans la réponse précédente » points at the stripped thought, so Task 5.
  - All three tasks still run, since the spec lists them all. The verdicts only reorder the expectations.
  - If the user is absent, stop here: no optimisation task may be decided without this reference.
- [ ] **Step 7: Commit:**
  ```
  git add electron/bench/reuse-report.mts electron/tests/bench-metrics.test.mts electron/package.json tasks/todo.md
  git commit -m "test: reuse verdicts per generation (cold, reused, checkpoint missing) and where the prompt diverged; the 27B reference measured" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 3: Checkpoints a hybrid model can restore — interval and memory cap

**Hypothesis.**
- A hybrid sequence restores only from a checkpoint (`LlamaContext.js:1081-1106`). The default interval is 8 192, and a 4 074-token prompt has none inside it.
- With an interval of 1 024, checkpoints are taken at batch ends (512), so one lands within about 1 536 tokens before any divergence.
- A·2–A·4 would then re-read ≤ about 1 600 tokens plus the new ones, instead of ≥ 4 100. That means about 29 s → ≤ about 11 s of reading at the measured 141 tok/s (CUDA, 19 layers) [hypothèse].
- Metric: evaluated tokens and `promptMs` on A·2–A·4. Cost: checkpoint RAM, capped.

**Files:**
- Modify: `electron/core/perf-levers.mts`, `electron/core/local-engine.mts` (`keep` :415), `electron/tests/perf-levers.test.mts`, `electron/tests/local-engine.test.mts`.

**Interfaces:**
- Consumes: `perfLevers()` (T1); the `reuse.checkpoints` figures (T1).
- Produces:
  - `PerfLevers` gains `checkpointInterval: number` (shipped 8192), `checkpointMax: number` (shipped 32) and `checkpointMaxMemory: number | null` (shipped null).
  - Rule: `checkpointInterval < 8192` with `checkpointMaxMemory === null` is rejected (`valeur invalide : checkpointInterval sans checkpointMaxMemory`).
  - `local-engine.mts`: `export function sequenceOptions(levers: Readonly<PerfLevers>): { checkpoints: { max: number; interval: number; maxMemory: number | null }; tokenPredictor?: TokenPredictor }`. `keep()` calls `context.getSequence(sequenceOptions(perfLevers()))`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  ```ts
  // perf-levers.test.mts
  test('the checkpoint levers: shipped at node-llama-cpp\'s defaults; a shorter interval needs a memory cap', () => {
    assert.deepEqual([SHIPPED_LEVERS.checkpointInterval, SHIPPED_LEVERS.checkpointMax, SHIPPED_LEVERS.checkpointMaxMemory], [8192, 32, null]);
    const ok = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointInterval: 1024, checkpointMaxMemory: 1610612736 }) });
    assert.deepEqual([ok.levers.checkpointInterval, ok.rejected], [1024, []]);
    const bad = readPerfLevers({ [PERF_LEVERS_ENV]: JSON.stringify({ checkpointInterval: 1024 }) });
    assert.deepEqual([bad.levers.checkpointInterval, bad.rejected], [8192, ['valeur invalide : checkpointInterval sans checkpointMaxMemory']]);
  });
  // local-engine.test.mts
  test('sequenceOptions passes the checkpoint levers to getSequence as they are', () => {
    assert.deepEqual(sequenceOptions(SHIPPED_LEVERS), { checkpoints: { max: 32, interval: 8192, maxMemory: null } });
    assert.deepEqual(sequenceOptions({ ...SHIPPED_LEVERS, checkpointInterval: 512, checkpointMaxMemory: 1 << 30 }).checkpoints, { max: 32, interval: 512, maxMemory: 1 << 30 });
  });
  ```
- [ ] **Step 2: Run** both files. Expect FAIL: `sequenceOptions` is not exported, and `checkpointInterval` is undefined.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run.** Expect PASS. Then the full suite, alone: **1094/1094**.
- [ ] **Step 5: Commit** the lever (shipped value unchanged):
  ```
  git add electron/core/perf-levers.mts electron/core/local-engine.mts electron/tests/perf-levers.test.mts electron/tests/local-engine.test.mts
  git commit -m "perf: checkpoint interval, count and memory cap as levers for hybrid models (shipped unchanged until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 6: Measure (protocol), scenario A.**
  - stories260K: `needsCheckpoints` is false on this attention model, so expect identical figures. This only proves nothing breaks.
  - 27B: « avant », then « après » with each candidate in turn:
    - (a) `checkpointInterval=1024 checkpointMaxMemory=1610612736`;
    - (b) `checkpointInterval=512 checkpointMaxMemory=1610612736`.
  - Compare evaluated tokens and `promptMs` on A·2–A·4, `checkpoints.memoryBytes`, and RSS.
- [ ] **Step 7: Keep or revert**, per the rule. On keep, `SHIPPED_LEVERS` takes the winning pair.
  - Before changing the default, update the two shipped-value assertions above.
  - Commit `perf: keep checkpoints every <n> tokens, capped at <m> — A·2 reads <x> instead of <y> tokens on the 27B (mesuré)` with `tasks/todo.md` and the `27b-t3-garde` results file name.

## Task 4: A stable head — the project context after the tool block

**Hypothesis.**
- The project context comes first today (`context.mts:22-53`): OPENAGENT.md, custom prompt, memory, learnings. Any change there, such as `save_memory`, a compaction note or the `.slice(-4000)` drift, re-reads everything after it, about 3 700 tool tokens included.
- Moving it after the tool block makes such a change cost only the context and the history. Expected: on A with a memory change before A·3, A·3 re-reads ≥ 3 000 fewer tokens [hypothèse].
- Metric: evaluated tokens on A·3 with `--touch-memory 3`.
- The Jinja wrapper merges adjacent system items (`JinjaTemplateChatWrapper.js:76`), so the context goes into a leading **user** item. That only happens when the template renders the tools after the system text: the probe below.

**Files:**
- Create: `electron/core/prompt-layout.mts`, `electron/tests/prompt-layout.test.mts`.
- Modify:
  - `electron/core/context.mts` (return value);
  - `electron/core/agent.mts` (`AgentOptions.projectContext`);
  - `electron/core/model-types.mts` (`CompletionOptions.projectContext`, `ChatWrapperInfo.toolsAfterSystem`);
  - `electron/core/local-provider.mts` (`historyFromMessages` option);
  - `electron/core/local-engine.mts` (`keep` computes the probe, `completeLocal` applies the lever);
  - `electron/worker.mjs` (`runSend` :762, compaction untouched);
  - `electron/core/perf-levers.mts`;
  - `electron/bench/run.mts` and `child.mts` (`--touch-memory <message>`);
  - tests `agent.test.mts`, `local-provider.test.mts`, `worker-tools.test.mts`, `context.test.mts`, `all.mts`.

**Interfaces:**
- Consumes: `perfLevers()`, the bench (T1).
- Produces:
  - `PerfLevers.contextPlacement: 'system' | 'after-tools'` (shipped `'system'`).
  - `context.mts::buildInstructions` returns `{ instructions, warnings, base: string, projectContext: string }`. `instructions` stays `[projectContext, base].filter(Boolean).join('\n\n')`, so every current caller is unchanged.
  - `prompt-layout.mts`:
    ```ts
    export interface RenderingWrapper { generateContextState(o: { chatHistory: unknown[]; availableFunctions?: Record<string, { description?: string; params?: unknown }> }): { contextText: { toString(): string } } }
    export function toolsAfterSystem(wrapper: RenderingWrapper): boolean;
    // renders [system '§S§', user '§U§', model []] with one function 'sonde_outil' described '§T§';
    // true when indexOf('§S§') < indexOf('§T§') < indexOf('§U§'); false on any throw
    export const CONTEXT_HEADER = '[CONTEXTE DU PROJET]';
    export function contextItem(projectContext: string): { type: 'user'; text: string };   // `${CONTEXT_HEADER}\n${projectContext}`
    ```
  - `local-provider.mts::historyFromMessages(messages, options?: { projectContext?: string; placement?: 'system' | 'after-tools' })`:
    - `'system'` (or no context) prepends the context to the system text exactly as today;
    - `'after-tools'` inserts `contextItem(...)` right after the system item.
  - `ChatWrapperInfo` gains `toolsAfterSystem: boolean`, computed in `keep()` and added to the `[chat]` log line as `contexte après les outils : oui|non`.
  - `completeLocal` uses `'after-tools'` only when the lever says so AND `wrapper.toolsAfterSystem`.
  - `AgentOptions` gains `projectContext?: string`:
    - `runAgent` sends `instructions` (the base) as the system message, and `projectContext` through `provider.complete({ …, projectContext })`;
    - `estimateRequestTokens` counts both;
    - the returned messages never contain the context.

**Steps:**
- [ ] **Step 1: Failing tests.** `tests/prompt-layout.test.mts` uses a real `JinjaTemplateChatWrapper` with no model:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { JinjaTemplateChatWrapper } from 'node-llama-cpp';
  import { toolsAfterSystem, contextItem, CONTEXT_HEADER } from '../core/prompt-layout.mts';
  import { historyFromMessages, toGgufFunctions } from '../core/local-provider.mts';

  const QWEN_LIKE = `{%- if tools %}<|im_start|>system\n{{ messages[0].content }}\n# Tools\n{%- for t in tools %}\n{{ t | tojson }}{%- endfor %}<|im_end|>\n{%- endif %}{%- for m in messages[1:] %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{%- endfor %}<|im_start|>assistant\n`;
  const TOOLS_FIRST = `{%- if tools %}<|im_start|>tools\n{%- for t in tools %}{{ t | tojson }}{%- endfor %}<|im_end|>\n{%- endif %}{%- for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{%- endfor %}<|im_start|>assistant\n`;

  test('toolsAfterSystem: true for a template that renders the tools inside the system part, false when they come first', () => {
    assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: QWEN_LIKE })), true);
    assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: TOOLS_FIRST })), false);
  });
  test('the context reaches the rendered prompt once, after the tools and before the first user message', () => {
    const wrapper = new JinjaTemplateChatWrapper({ template: QWEN_LIKE });
    const history = historyFromMessages([{ role: 'system', content: 'BASE' }, { role: 'user', content: 'QUESTION' }], { projectContext: 'MÉMOIRE-X', placement: 'after-tools' });
    assert.deepEqual(history[1], contextItem('MÉMOIRE-X'));
    const text = wrapper.generateContextState({ chatHistory: history as never, availableFunctions: toGgufFunctions([{ type: 'function', function: { name: 'read_file', description: 'LIRE', parameters: { type: 'object', properties: {} } } }]) as never }).contextText.toString();
    assert.equal(text.split('MÉMOIRE-X').length, 2);
    assert.ok(text.indexOf('LIRE') < text.indexOf(CONTEXT_HEADER) && text.indexOf(CONTEXT_HEADER) < text.indexOf('QUESTION'));
  });
  ```
  The two templates are first rendered once by hand in Step 3. If `JinjaTemplateChatWrapper` rejects one for a missing function-call syntax, add `functionCallMessageTemplate` settings until it renders. The assertions must not change.
  - `local-provider.test.mts`: `'system' placement keeps today's system text byte for byte`. It asserts that `historyFromMessages([...], { projectContext: 'C', placement: 'system' })[0].text === 'C\n\nBASE'`, the string `buildInstructions` builds today.
  - `agent.test.mts`: `the saved transcript has no context item, and the provider gets projectContext apart`. The scripted provider records `options.projectContext === 'CTX'` and `options.messages[0].content === 'BASE'`, and the result holds no message containing `'CTX'`.
  - `worker-tools.test.mts`: `two listings in a row offer the same tools in the same order`. Two `plugin-list` calls on the same folder return `deepEqual` name arrays.
  - `context.test.mts`: `buildInstructions returns base and projectContext apart, and instructions is still their join`.
- [ ] **Step 2: Run** the five files. Expect FAIL: the module is not found, `projectContext` is not forwarded, and `base` is undefined.
- [ ] **Step 3: Implement** per the Interfaces. `worker.mjs` passes `base` as `instructions` and `projectContext` to `runAgent`. Nothing else in `runSend` changes.
- [ ] **Step 4: Run** the five files, then `agent-parity`, `request-context` and `worker-request`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1100/1100** (+6: prompt-layout 2, local-provider 1, agent 1, worker-tools 1, context 1), with `prompt-layout` added to `all.mts`.
- [ ] **Step 6: Commit** (shipped `'system'`):
  ```
  git add electron/core/prompt-layout.mts electron/core/context.mts electron/core/agent.mts electron/core/model-types.mts electron/core/local-provider.mts electron/core/local-engine.mts electron/core/perf-levers.mts electron/worker.mjs electron/bench/run.mts electron/bench/child.mts electron/tests/prompt-layout.test.mts electron/tests/local-provider.test.mts electron/tests/agent.test.mts electron/tests/worker-tools.test.mts electron/tests/context.test.mts electron/tests/all.mts
  git commit -m "perf: the project context can follow the tool block when the template renders tools in the system part (lever, shipped unchanged until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure**, scenario A with `--touch-memory 3`.
  - The child appends `\n<!-- bench -->\n- Le banc d'essai a noté une préférence.` to the project `memory.md` before message 3, through the worker's own data path.
  - 27B: « avant », then « après » with `contextPlacement=after-tools`. Read the `[chat]` line in the log: `contexte après les outils : oui` is required, else the lever cannot apply to this model. Record that and revert.
  - Metrics: evaluated tokens on A·3, and A·4's reply, which must still answer.
- [ ] **Step 8: Keep or revert**, per the rule. Commit as in Task 3, Step 7.

## Task 5: Keep the previous thought, and pass the last evaluation window back

**Hypothesis.**
- **Keeping the thought.**
  - Today the reasoning is never sent back (`request-context.mts:52-56, 72`). The re-rendered reply therefore differs from the generated tokens, and the divergence sits in the previous reply (Task 2's « dans la réponse précédente »).
  - Sending the last thought back as a `thought` segment moves the divergence to after the previous reply. A·2–A·4 would then re-read only the new user message plus the template tokens [hypothèse].
  - Cost: context fills faster.
- **The last evaluation window.**
  - Passing `lastEvaluationContextWindow` / `contextShift.lastEvaluationMetadata` back only matters when node-llama-cpp must shift the context.
  - `fitToBudget` keeps requests under the window, so the expected gain on A/B/C is **none** [hypothèse]. It is measured anyway, and reverted on no gain.

**Files:**
- Modify:
  - `electron/core/request-context.mts` (`requestMessages` :65-74, option);
  - `electron/core/local-provider.mts` (`GgufHistoryItem` model response accepts a segment; `historyFromMessages` renders `reasoning`);
  - `electron/core/local-engine.mts` (`Loaded.lastEvaluation`, `completeLocal`);
  - `electron/core/agent.mts` (passes the option);
  - `electron/core/perf-levers.mts`;
  - tests `request-context.test.mts`, `local-provider.test.mts`, `local-engine.test.mts`.

**Interfaces:**
- Consumes: `perfLevers()`.
- Produces:
  - `PerfLevers.keepThought: boolean` (false) and `PerfLevers.reuseLastEvaluation: boolean` (false).
  - `requestMessages(messages, options?: { keepThought?: boolean })`:
    - with `keepThought`, the assistant messages of the current turn keep `reasoning`;
    - the LAST assistant message of the previous turn keeps its text AND its `reasoning`;
    - `reasoningMs` and `timing` are always stripped.
  - `historyFromMessages`: an assistant message with `reasoning` gets `{ type: 'segment', segmentType: 'thought', text: reasoning, ended: true }` as its FIRST response item.
  - `local-engine.mts`: `export function generationExtras(levers: Readonly<PerfLevers>, last: { history: unknown[]; metadata: unknown } | null): { lastEvaluationContextWindow?: { history: unknown[] }; contextShift?: { lastEvaluationMetadata: unknown } }`. It returns `{}` unless the lever is on and `last` is set. `Loaded.lastEvaluation` is reset on every load and stored from `response.lastEvaluation` after each generation.
  - `agent.mts` reads `perfLevers().keepThought` and passes it to `requestMessages`. The agent is not engine-specific, but only the local engine renders a thought. A test provider ignores `reasoning`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  ```ts
  // request-context.test.mts
  test('keepThought keeps the reasoning of the previous turn\'s last reply and of this turn, never reasoningMs or timing', () => {
    const msgs = [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'r1', reasoning: 'T1', reasoningMs: 5, timing: { totalMs: 1 } },
      { role: 'user', content: 'b' }, { role: 'assistant', content: '', reasoning: 'T2', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
    ] as ChatMessage[];
    const out = requestMessages(msgs, { keepThought: true });
    assert.deepEqual(out[1], { role: 'assistant', content: 'r1', reasoning: 'T1' });
    assert.equal(out[3].reasoning, 'T2');
    assert.equal(requestMessages(msgs)[1].reasoning, undefined, 'off by default');
  });
  // local-provider.test.mts
  test('a reasoning becomes the first thought segment of the model item', () => {
    const [, model] = historyFromMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'r', reasoning: 'T' }] as ChatMessage[]);
    assert.deepEqual(model, { type: 'model', response: [{ type: 'segment', segmentType: 'thought', text: 'T', ended: true }, 'r'] });
  });
  // local-engine.test.mts
  test('generationExtras passes the last evaluation back only with the lever and a previous evaluation', () => {
    const last = { history: [{ type: 'user', text: 'x' }], metadata: { k: 1 } };
    assert.deepEqual(generationExtras(SHIPPED_LEVERS, last), {});
    assert.deepEqual(generationExtras({ ...SHIPPED_LEVERS, reuseLastEvaluation: true }, null), {});
    assert.deepEqual(generationExtras({ ...SHIPPED_LEVERS, reuseLastEvaluation: true }, last),
      { lastEvaluationContextWindow: { history: last.history }, contextShift: { lastEvaluationMetadata: last.metadata } });
  });
  ```
- [ ] **Step 2: Run** the three files. Expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** the three files, plus `agent`, `reasoning-split` and `local-engine`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1103/1103** (+3).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/request-context.mts electron/core/local-provider.mts electron/core/local-engine.mts electron/core/agent.mts electron/core/perf-levers.mts electron/tests/request-context.test.mts electron/tests/local-provider.test.mts electron/tests/local-engine.test.mts
  git commit -m "perf: levers to send the previous thought back as a thought segment and to pass the last evaluation window back (shipped unchanged until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure**, scenarios A and B, each lever on its own:
  - `keepThought=true`: metrics are evaluated tokens on A·2–A·4 and B's quality;
  - `reuseLastEvaluation=true`: metric is `promptMs` on A.
- [ ] **Step 8: Keep or revert each lever separately**, per the rule.

## Task 6: Lighter tool definitions — same tools, same contracts

**Hypothesis.**
- The tool JSON is about 88 % of the 4 074-token cold read [hypothèse from the research's hand count]. Task 2 replaces that with the measured `toolDefinitions.tokens`.
- Cutting descriptions and schema noise by ≥ 40 % of the tool JSON saves about 1 500 tokens per full read: about 10 s on CUDA/19 layers, about 23 s on CPU at the measured 65 tok/s [hypothèse].
- Metrics: `toolDefinitions.chars` and `.tokens`, and A·1's evaluated tokens. Quality: scenario B and every agent and tool test.

**Files:**
- Create: `electron/tests/support/tool-contract.mts`, `electron/tests/fixtures/tool-contracts.v1.json`, `electron/tests/tool-contracts.test.mts`.
- Modify:
  - descriptions only in `electron/core/workspace.mts`, `git-tools.mts`, `memory-tools.mts`, `project-analyzer.mts`, `shell-tool.mts`, `web-tools.mts`, `search-tools.mts`;
  - `electron/core/local-provider.mts` (`compactSchema` in `toGgufFunctions`);
  - `electron/tests/local-provider.test.mts`, `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `builtInTools` and `toolSchemas` (T1); `bench/tool-tokens.mts` (T1).
- Produces:
  - `tests/support/tool-contract.mts`: `export function toolContract(tool: AgentTool): ToolContract`, where `ToolContract = { name; category; required: string[] /*sorted*/; additionalProperties: unknown; properties: Record<string, PropertyContract> }`.
    - `PropertyContract` keeps every schema key EXCEPT `description`, recursively: `type`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format`, `items`, `default`, `properties`, `required`.
    - A missing `required` normalises to `[]`.
  - `local-provider.mts`: `export function compactSchema(schema: unknown): unknown`. It drops `$schema`, `title`, `examples`, `$comment` and an empty `required: []`, recursively. It keeps everything else, `additionalProperties` and descriptions included. `toGgufFunctions` applies it to `params`, which covers MCP schemas too.
- Description rules: a tool description ≤ 160 characters, in the same language as today, with its constraint sentences kept: what it refuses, its limits, where it reads. A parameter description ≤ 80 characters, removed only when it repeats the name and type, never when it carries a format, a unit or a limit.

**Steps:**
- [ ] **Step 1: Freeze the contracts at HEAD, before any edit.**
  - Write `tests/support/tool-contract.mts`.
  - Generate `tests/fixtures/tool-contracts.v1.json`: the sorted array of `toolContract` over `builtInTools(<empty temp folder>, <temp home>, '')`, written with the edit tools as LF JSON, two-space indent.
  - Record the « avant » figures:
    - `npm run bench:tools -- --model tests/fixtures/stories260K.gguf` (chars, stories tokens);
    - the 27B tokens, which wait for the 27B session.
- [ ] **Step 2: Write the tests.** `tests/tool-contracts.test.mts`:
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { readFile, mkdtemp } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { builtInTools } from '../core/builtin-tools.mts';
  import { toolContract } from './support/tool-contract.mts';
  import { removeAtEnd } from './teardown.mts';

  const frozen = JSON.parse(await readFile(new URL('./fixtures/tool-contracts.v1.json', import.meta.url), 'utf8'));
  async function current(t: { after(fn: () => unknown): void }) {
    const root = await mkdtemp(join(tmpdir(), 'openagent-contracts-'));
    removeAtEnd(t, root);
    return (await builtInTools(root, root, '')).map(toolContract).sort((a, b) => a.name.localeCompare(b.name));
  }
  test('no tool removed: the same 34 built-in tool names as before the slimming', async t => {
    assert.deepEqual((await current(t)).map(c => c.name), frozen.map((c: any) => c.name));
    assert.equal(frozen.length, 34);
  });
  test('no argument contract weakened: every schema equals the frozen one, descriptions aside', async t => {
    assert.deepEqual(await current(t), frozen);
  });
  test(`the default tool set's JSON is at most ${BUDGET} characters`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-contracts-'));
    removeAtEnd(t, root);
    assert.ok(JSON.stringify(await builtInTools(root, root, '')).length <= BUDGET);
  });
  ```
  - `BUDGET = Math.floor(0.6 × <the chars measured in Step 1>)` is written as a literal number in the file. The 34-tool count is the research's count; the real count comes from the frozen file in Step 1 and replaces 34 if it differs.
  - `local-provider.test.mts`: `compactSchema drops $schema, title, examples and an empty required, and keeps types, enums, required, additionalProperties and descriptions`, with a nested MCP-like schema.
- [ ] **Step 3: Run.** Expect: names and contracts PASS (frozen from HEAD, so they are guards); the size budget FAILs (`false == true`); `compactSchema` FAILs (not exported).
- [ ] **Step 4: Shorten the descriptions** per the rules, module by module, and implement `compactSchema`.
  - Touch only `description` strings.
  - After each module, run its own test file and `tests/tool-contracts.test.mts`.
- [ ] **Step 5: Run** `tool-contracts`, `local-provider`, `agent`, `agent-parity`, `workspace`, `workspace-search`, `git-tools`, `memory-tools`, `shell-tool`, `web-tools`, `search-tools`, `project-analyzer`, `system-prompt`, `worker-tools`, `worker-git-tools` and `worker-search-tools`. Expect PASS.
- [ ] **Step 6: Full suite**, alone. Expect **1107/1107** (+4: tool-contracts 3, local-provider 1), with `tool-contracts` added to `all.mts`.
- [ ] **Step 7: The report.**
  - `npm run bench:tools` on stories260K, « après ».
  - 27B (user present): `bench:tools` « avant » runs on the parent commit, checked out in a temporary worktree outside the repository (`git worktree add <temp dir> HEAD`, before this task's commit; `git worktree remove` afterwards). « Après » runs on the working tree. Then scenarios A and B the same way.
  - Write in `tasks/todo.md` a table « Définitions des outils » with chars, stories tokens, 27B tokens, and per-tool chars for the five largest, avant / après, each marked « mesuré ».
- [ ] **Step 8: Keep or revert**, per the rule.
  - Keep needs fewer evaluated tokens on A·1 AND B quality intact on the 27B.
  - A revert restores the descriptions, `compactSchema` and the size test, and keeps the contract guard tests: they protect every later change.
- [ ] **Step 9: Commit:**
  ```
  git add electron/core/workspace.mts electron/core/git-tools.mts electron/core/memory-tools.mts electron/core/project-analyzer.mts electron/core/shell-tool.mts electron/core/web-tools.mts electron/core/search-tools.mts electron/core/local-provider.mts electron/tests/support/tool-contract.mts electron/tests/fixtures/tool-contracts.v1.json electron/tests/tool-contracts.test.mts electron/tests/local-provider.test.mts electron/tests/all.mts tasks/todo.md
  git commit -m "perf: tool definitions <x> → <y> characters (<a> → <b> tokens on the 27B, mesuré) — no tool removed, every argument contract unchanged (frozen fixture)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 7: Load faster (1) — the engine at boot, and the load beside the tool preparation

**Hypothesis.**
- **Engine at boot.** `getLlama` and its binary test run on the first message today (`worker.mjs:909-923` only via `hardware-info`). Starting them at worker start, when an active local model is set, removes the `engine` stage from the first turn when the user waits longer than it before sending.
  - The code comments (`worker.mjs:900-903`, `llama-runtime.mts:59-61`) report > 30 s on the owner's machine [hypothèse]; Task 2's C-froid measures it.
- **Overlap.** Starting the load during `registerTools` + `buildInstructions` saves min(preparing, load).
  - preparing measured 15 ms without MCP (partB2), so the expected gain is ≈ 0 without MCP servers, and up to the discovery time (≤ 10 s, `mcp-client.mts:26`) with them [hypothèse].
  - Measured with `--mcp-fake 1500` (Task 14 adds that option; until then this sub-lever is measured without MCP).

**Files:**
- Modify:
  - `electron/core/perf-levers.mts`;
  - `electron/worker.mjs` (start-up after line 189; `runSend` 750-831; `shutdownWorker` waits for the engine start);
  - `electron/bench/child.mts` and `run.mts` (`--idle-before-send <ms>`);
  - `electron/tests/worker-engine-start.test.mts`, `electron/tests/worker-turn-phases.test.mts`.

**Interfaces:**
- Consumes: `startEngine()` (`worker.mjs:909`), `track()` (`worker.mjs:132-136`), `windowFor` (`:231`).
- Produces:
  - `PerfLevers.engineAtBoot: boolean` (false) and `PerfLevers.overlapLoad: boolean` (false).
  - At worker start, with `engineAtBoot` and a non-empty `active_local_model`: `track(startEngine().catch(() => {}), 'démarrage du moteur')`. Shutdown already waits for `work`, so it waits for this too.
  - With `overlapLoad`, `runSend` starts `provider.contextWindow({ signal, onLoad })` right after `turnProvider` returns. Then:
    - it awaits it after `buildInstructions`;
    - it applies the `max_tokens` cap of `turnWindow` (`turn-window.mts:15-19`) to the result;
    - `estimateJobs.cancelAll()` + `await jobs.idle()` run before the early load, as `turnWindow` does today.
  - A load failure or abort in that early promise surfaces at the await, never as an unhandled rejection: attach `.catch` at creation and rethrow at the await.

**Steps:**
- [ ] **Step 1: Failing tests.**
  ```ts
  // worker-engine-start.test.mts
  test('with engineAtBoot and an active local model, the engine is ready without any op', { timeout: 120000 }, async t => {
    const { worker } = await setupWithActiveModel(t, { [PERF_LEVERS_ENV]: JSON.stringify({ engineAtBoot: true }) });
    const event = await firstEvent(worker, m => m.event === 'engine', 100000);
    assert.equal(event.state, 'ready');
  });
  test('shutdown right after start with engineAtBoot ends cleanly (no 0xC0000409)', { timeout: 120000 }, async t => {
    const child = await spawnWorkerHost(t, { [PERF_LEVERS_ENV]: JSON.stringify({ engineAtBoot: true }), activeModel: true, shutdownAfterMs: 50 });
    assert.equal(await exitCodeOf(child), 0);
  });
  // worker-turn-phases.test.mts
  test('with overlapLoad, the load starts while the tools are still being prepared (a 1.5 s MCP server)', { timeout: 120000 }, async t => {
    const { worker, folder, home } = await setupLocalWithFakeMcp(t, { FAKE_MCP_INIT_DELAY_MS: '1500', [PERF_LEVERS_ENV]: JSON.stringify({ overlapLoad: true }) });
    const rec = recordAgentEvents(worker);
    const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'Once upon a time' });
    await rec.until(runId, { timeoutMs: 110000 });
    const lines = await dayLines(home);
    const start = Date.parse(lines.find(l => l.event === 'turn-start').at);
    const loading = Date.parse(lines.find(l => l.event === 'phase' && l.phase === 'loading').at);
    assert.ok(loading - start < 1000, `loading started ${loading - start} ms after the turn, before the MCP server answered`);
  });
  ```
  - The helpers come from the existing files: `quit.test.mts`'s child host pattern for `spawnWorkerHost`/`exitCodeOf` (`tests/support/quit-child.mts`), and `worker-mcp.test.mts`'s global `mcp-add` of `fixtures/fake-mcp-server.cjs` for the MCP setup.
  - Read both files first and reuse them; do not duplicate them.
- [ ] **Step 2: Run** both files. Expect FAIL: no `engine` event within the time; `loading` comes after ≥ 1 500 ms.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** both files, plus `worker-turn-phases`, `worker-turn-log`, `turn-window`, `worker-local-model` and `quit`. Expect PASS.
- [ ] **Step 5: Start-up audit** (global constraint): `git grep -l "worker.mjs" -- electron/tests electron/bench`. Every spawner sets `OPENAGENT_HOME`.
- [ ] **Step 6: Full suite**, alone. Expect **1110/1110** (+3).
- [ ] **Step 7: Commit:**
  ```
  git add electron/core/perf-levers.mts electron/worker.mjs electron/bench/child.mts electron/bench/run.mts electron/tests/worker-engine-start.test.mts electron/tests/worker-turn-phases.test.mts
  git commit -m "perf: levers to start the engine at worker start when a local model is active, and to load the model while the tools are prepared (shipped unchanged until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 8: Measure**, scenario C with `--idle-before-send 10000` on both sides, and A for `overlapLoad`.
  - Metrics: the `engine` stage and `loadMs` of C-froid; the `preparing` + `loading` time of A·1.
- [ ] **Step 9: Keep or revert each lever**, per the rule.
  - If `engineAtBoot` is kept, the window tests that read the `engine` event or `data-reads` (`hardware-visual.cjs`, lesson 2026-10-24) go on the Task 15 list.
  - If `overlapLoad` is kept, `local-model-visual.cjs` and `stop-visual.cjs` go on it too.

## Task 8: Load faster (2) — the remembered layer count, loaded as a number, with explicit mmap

**Hypothesis.**
- A remembered limit loads with `{ min: 0, max: limit, fitContext }` (`local-engine.mts:360`), so node-llama-cpp still runs its fitContext probes. A numeric `gpuLayers` with an explicit `useMmap` needs a single probe (`resolveModelGpuLayersOption.js:21-84`, per the research).
- Expected: C-chaud's `loadModel` stage −1 to −2 s (partB2's pre-load resolution was 1.4 s) [hypothèse].
- The step-down retries (13.8 s in partB2) are already skipped by the existing remembered limit, which Task 2's C-chaud measures.

**Files:**
- Modify: `electron/core/perf-levers.mts`, `electron/core/local-engine.mts` (`loadFresh` 352-388), `electron/tests/low-vram-fallback.test.mts`.

**Interfaces:**
- Consumes: `recallLimit` (`:255`), the step-down loop.
- Produces:
  - `PerfLevers.numericLimitLoad: boolean` (false).
  - With it, and only while the limit applies, the FIRST attempt is `loadModel({ modelPath, gpuLayers: limit, useMmap: llama.supportsMmap, loadSignal, onLoadProgress })`.
  - If that attempt throws `InsufficientMemoryError`, the loop continues with `max = limit` (today's fitContext path). It never goes straight to the processor (lesson 2026-10-24, the 25/66 → 0/66 regression).
  - A `createContext` refusal steps down as today.

**Steps:**
- [ ] **Step 1: Failing tests**, in `low-vram-fallback.test.mts`, with its `inChild` and remembered-limit setup (`test('a remembered step-down…'` at :192):
  - `numericLimitLoad: the second cold load makes one loadModel with gpuLayers equal to the remembered count and an explicit useMmap`. It asserts `m.nativeLoadCount()` grew by 1, `[placement]` says `limite mémorisée : N couches`, and `model.useMmap === llama.supportsMmap`.
  - `numericLimitLoad: a numeric load refused by loadModel continues at fitContext ≤ the limit, never the processor`. It uses the file's VRAM cap seam to make the numeric attempt refuse, and asserts the placement is not `fallback` and `gpuLayers ≤ limit`.
  - Both run with `OPENAGENT_PERF_LEVERS={"numericLimitLoad":true}` in the child env.
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/low-vram-fallback.test.mts`. Expect FAIL: 2 loadModel calls instead of 1 (fitContext probes count as one native load, so the second assertion fails on `useMmap`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `low-vram-fallback`, `local-engine` and `worker-replacement`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1112/1112** (+2).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/perf-levers.mts electron/core/local-engine.mts electron/tests/low-vram-fallback.test.mts
  git commit -m "perf: lever to load a remembered layer count as a number with explicit mmap (one probe), falling back to fitContext under the limit, never straight to the processor" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure**, scenario C, 27B: the `loadModel` stage and `loadMs` of C-chaud, and its layer count.
- [ ] **Step 8: Keep or revert**, per the rule. A different layer count than « avant » counts as a regression.

## Task 9: « Longueur maximale de la réflexion » — a setting, no limit by default

This is a user decision (spec, 2026-10-25), not a measured lever. The setting stays whatever the measurements say, and its default changes nothing.

**Where in Réglages: Matériel.**
- The setting only acts on the built-in engine (`budgets.thoughtTokens`), as « Contexte des modèles locaux » does, which already lives in Matériel and is saved by the same draft (`HardwareTab.tsx:259-271`).
- Contexte & Mémoire sizes the request window and compaction for the conversation; a cap on generated thought tokens is an engine generation setting.

**Hypothesis:** no change by default. With 512, a 27B turn thinks ≤ 512 tokens. Measured on A to show the cap holds; no default change.

**Files:**
- Modify:
  - `electron/core/settings.mts` (defaults 5-24 and rules 36-48);
  - `electron/core/local-engine.mts` (`localProvider` gains a generation request; `completeLocal` budget);
  - `electron/worker.mjs` (`turnProvider` 580-594 passes the setting);
  - `electron/renderer-src/src/components/settings/hardware-view.ts`, `HardwareTab.tsx` (after the `local_context` row);
  - `electron/tests/local-context.test.mts`, `electron/tests/hardware-view.test.mts`, `electron/tests/local-engine.test.mts`;
  - `electron/tests/hardware-visual.cjs` (edited, run in T15).

**Interfaces:**
- Consumes: `levers.thoughtTokens` (T1).
- Produces:
  - `settings.mts`: `max_thought_tokens: null as number | null`, with the rule `v === null || choice(512, 1024, 2048, 4096, 8192)(v)`.
  - `local-engine.mts`:
    - `export interface GenerationRequest { thoughtTokens: number | null }`;
    - `export function thoughtBudget(setting: number | null, lever: number | null): number`, which returns `lever ?? setting ?? Infinity`;
    - `localProvider(modelPath, request?, generation?: GenerationRequest)`, whose `completeLocal` passes `budgets: { thoughtTokens: thoughtBudget(...) }`.
  - `hardware-view.ts`: `export const THOUGHT_BUDGET_OPTIONS: ReadonlyArray<{ value: number | null; label: string }>` = `[{ null, 'Sans limite (défaut)' }, { 512, '512' }, { 1024, '1k' }, { 2048, '2k' }, { 4096, '4k' }, { 8192, '8k' }]`.
  - `HardwareTab.tsx`: a `Row` with `label="Longueur maximale de la réflexion"` and `hint="En jetons. Au-delà, le modèle arrête de réfléchir et écrit sa réponse."`, holding a `select` with `data-setting="max_thought_tokens"`. Its value is `'none'` for null, and `onChange` maps `'none'` back to `null`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  ```ts
  // local-context.test.mts
  test('max_thought_tokens: no limit by default; accepts null and the listed sizes; refuses anything else', async t => {
    const home = await tempHome(t);
    const service = new SettingsService(home);
    assert.equal((await service.global()).max_thought_tokens, null);
    for (const ok of [null, 512, 1024, 2048, 4096, 8192]) await service.saveGlobal({ max_thought_tokens: ok });
    for (const bad of [0, -1, 100, '512', Infinity]) await assert.rejects(service.saveGlobal({ max_thought_tokens: bad }));
  });
  // local-engine.test.mts
  test('thoughtBudget: no limit is Infinity (node-llama-cpp\'s own default is 75 % of the context); the bench lever wins over the setting', () => {
    assert.equal(thoughtBudget(null, null), Infinity);
    assert.equal(thoughtBudget(1024, null), 1024);
    assert.equal(thoughtBudget(1024, 256), 256);
  });
  // hardware-view.test.mts
  test('THOUGHT_BUDGET_OPTIONS: « Sans limite (défaut) » first, then 512 to 8k', () => {
    assert.deepEqual(THOUGHT_BUDGET_OPTIONS.map(o => o.label), ['Sans limite (défaut)', '512', '1k', '2k', '4k', '8k']);
    assert.equal(THOUGHT_BUDGET_OPTIONS[0].value, null);
  });
  ```
  - `hardware-visual.cjs` gets a new step after the `local_context` one (`:227-236`):
    - the select shows `none`;
    - choosing `1024` through a real `change` event and « Enregistrer » writes `max_thought_tokens: 1024` to `config.json`.
  - Every `waitFor` added there is re-read for its value on the initial state (lesson 2026-10-18).
- [ ] **Step 2: Run** the three node files. Expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** the three files and `settings-relaxations`, then `npx tsc --noEmit -p renderer-src/tsconfig.json` (0) and `npm run renderer:build` (exit 0), each alone.
- [ ] **Step 5: Full suite**, alone. Expect **1115/1115** (+3).
- [ ] **Step 6: Measure (informative)**, 27B, scenario A:
  - with `max_thought_tokens` 512 set through `save-global-settings` (the bench gains `--setting key=value`), and WITHOUT the `thoughtTokens` lever;
  - record the thought tokens per reply (`reply.reasoning` length from the log) and the turn time, against the reference.
- [ ] **Step 7: Commit:**
  ```
  git add electron/core/settings.mts electron/core/local-engine.mts electron/worker.mjs electron/renderer-src/src/components/settings/hardware-view.ts electron/renderer-src/src/components/settings/HardwareTab.tsx electron/tests/local-context.test.mts electron/tests/hardware-view.test.mts electron/tests/local-engine.test.mts electron/tests/hardware-visual.cjs electron/bench/child.mts electron/bench/run.mts tasks/todo.md
  git commit -m "feat: « Longueur maximale de la réflexion » in Réglages › Matériel — no limit by default (node-llama-cpp's budgets.thoughtTokens set to Infinity, its own default being 75 % of the context), 512 to 8k" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 10: Write faster (1) — prediction by input lookup

**Hypothesis.**
- `InputLookupTokenPredictor` drafts tokens that repeat the input, with no extra model and an unchanged output.
- Expected: tok/s +10 to +30 % on echo-heavy replies (B, which quotes the file) and ≈ 0 or negative on prose (A) [hypothèse, external figures only].
- On a hybrid model each speculative round takes a checkpoint (`LlamaContext.js:1620-1627`, per the research), which may cancel the gain.
- Metric: tok/s on B and A, `predictions.validated / (validated + refuted)`.

**Files:**
- Modify: `electron/core/perf-levers.mts`, `electron/core/local-engine.mts` (`sequenceOptions`, `GenerationStats.predictions`), `electron/core/model-types.mts`, `electron/core/turn-log.mts`, `electron/worker.mjs` (`generation` line), `electron/bench/metrics.mts` (`GenerationFigures.predictions`), `electron/tests/local-engine.test.mts`.

**Interfaces:**
- Consumes: `sequenceOptions` (T3).
- Produces:
  - `PerfLevers.inputLookup: boolean` (false). `sequenceOptions` adds `tokenPredictor: new InputLookupTokenPredictor()` when it is on.
  - `GenerationStats.predictions?: { validated: number; refuted: number; used: number; unused: number }`, the diff of `sequence.tokenPredictions` over the call. It is logged on `generation` and copied into `GenerationFigures`.

**Steps:**
- [ ] **Step 1: Failing tests** (`local-engine.test.mts`):
  - `sequenceOptions adds an InputLookupTokenPredictor only with the lever`: `instanceof InputLookupTokenPredictor`, and no key when off.
  - `with inputLookup, stories260K writes the same greedy text and counts its predictions`:
    - one engine load per lever value: a child process with `OPENAGENT_PERF_LEVERS`, using `low-vram-fallback`'s `inChild` pattern, since `perfLevers()` is read once per thread;
    - the same 24-token completion of `'Once upon a time'` both times;
    - assert the texts are equal and `predictions.validated + predictions.refuted > 0` with the lever.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `local-engine` and `worker-turn-log`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1117/1117** (+2).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/perf-levers.mts electron/core/local-engine.mts electron/core/model-types.mts electron/core/turn-log.mts electron/worker.mjs electron/bench/metrics.mts electron/tests/local-engine.test.mts
  git commit -m "perf: lever for input-lookup token prediction (same output, no extra model), its predictions counted in the turn log (shipped off until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure**, scenarios A and B, then **Step 8: keep or revert**, per the rule. A different reply text at the same seed counts as a regression.

## Task 11: Write faster (2) — prompt batch size, threads, KV cache q8_0

**Hypothesis.**
- **`batchSize`.** 1 024 or 2 048, against 512 today (`LlamaContext.js:1978-1979`). It speeds up prompt reading with partial offload, but its larger compute buffer may cost layers: reading +10 to +40 % or a layer lost [hypothèse].
- **`threads`.** `cpuMathCores ± 2`, against the default: ±5 % [hypothèse].
- **KV `Q8_0`.** On a hybrid model only about 16 of the layers hold a KV cache, so it saves little VRAM: perhaps +1 layer, tok/s ±3 %, small quality risk [hypothèse, external].
- Metrics: A·1 `promptMs`, tok/s, `gpuLayers`.

**Files:**
- Modify: `electron/core/perf-levers.mts`, `electron/core/local-engine.mts` (both `createContext` calls :372, :402; `cpuFallback` KV type :300), `electron/core/offload-estimate.mts` (the KV type of the estimate follows the lever), `electron/tests/local-engine.test.mts`.

**Interfaces:**
- Produces:
  - `PerfLevers.batchSize: number | null` (null), `PerfLevers.threads: number | null` (null) and `PerfLevers.kvCacheType: 'F16' | 'Q8_0'` ('F16').
  - `export function contextOptions(levers): { batchSize?: number; threads?: number; experimentalKvCacheKeyType?: 'Q8_0'; experimentalKvCacheValueType?: 'Q8_0' }`. It returns no key for a shipped value, and is spread into both `createContext` calls.
  - `cpuFallback` and the estimate pass `GgmlType[levers.kvCacheType]`, so the shown and loaded figures stay one (lesson of turn diagnostics, Task 1b).

**Steps:**
- [ ] **Step 1: Failing tests:**
  - `contextOptions maps the levers and returns {} at the shipped values`;
  - `stories260K loads and writes with batchSize 1024 and a Q8_0 KV cache`, in a child process with the levers, asserting non-empty text and `context.batchSize === 1024` through `warmContext()`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `local-engine`, `offload-estimate`, `low-vram-fallback` and `worker-estimate`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1119/1119** (+2).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/perf-levers.mts electron/core/local-engine.mts electron/core/offload-estimate.mts electron/tests/local-engine.test.mts
  git commit -m "perf: levers for the prompt batch size, the thread count and a q8_0 KV cache, the estimate following the KV type (shipped unchanged until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure** each value alone on the 27B with scenario A: `batchSize` 1024, then 2048; `threads` math cores −2 and +2 (read `llama.cpuMathCores` in the worker log); `kvCacheType=Q8_0`.
- [ ] **Step 8: Keep or revert each**, per the rule. A lost layer counts against `batchSize` only when the tok/s loss outweighs the reading gain over A·1–A·4 in total time.

## Task 12: The re-placement between turns weighs the cost of emptying the cache

**Hypothesis.**
- A re-placement reloads, which empties the sequence. The next message then re-reads the whole conversation (`held` tokens).
- Requiring more extra layers as that re-read grows avoids a reload that costs more than it brings [hypothèse].
- This lever cannot be triggered by A, B or C (it needs the VRAM to free up between turns). Its proof is the decision tests, plus the `[placement]` reason that now states the re-read estimate. Keep rule: tests green and A/B/C without regression.

**Files:**
- Modify: `electron/core/local-engine.mts` (`ReplacementInput`/`replacementDecision` 494-517, `replacementCheck` 521-543, `Loaded.lastReadRate`), `electron/tests/replacement.test.mts`.

**Interfaces:**
- Consumes: `GenerationStats.promptMs` and `reuse.evaluated` (T1).
- Produces:
  - `ReplacementInput` gains `heldTokens: number` and `readTokensPerSecond: number | null`.
  - `export const REREAD_MS_PER_EXTRA_LAYER = 15_000`.
  - Rule: `required = REPLACE_MIN_LAYERS + Math.floor(rereadMs / REREAD_MS_PER_EXTRA_LAYER)`, where `rereadMs = readTokensPerSecond ? heldTokens / readTokensPerSecond * 1000 : 0`.
  - The reason adds `relecture estimée ${Math.round(rereadMs / 1000)} s`.
  - `Loaded.lastReadRate` = `evaluated / (promptMs / 1000)` of the last generation, null until one ran.

**Steps:**
- [ ] **Step 1: Failing tests** (`replacement.test.mts`):
  ```ts
  test('a long conversation to re-read asks for more extra layers before reloading', () => {
    const base = { outcome: 'step-down' as const, gpuLayers: 19, totalLayers: 66, freeAtLoad: 0, loadedVram: 0, bytesPerLayer: 100 };
    // 5 extra layers fit; 4 100 tokens at 141 tok/s ≈ 29 s → 4 + 1 = 5 required: reload
    assert.equal(replacementDecision({ ...base, freeNow: 500, heldTokens: 4100, readTokensPerSecond: 141 }).replace, true);
    // 9 000 tokens ≈ 64 s → 4 + 4 = 8 required: no reload
    const no = replacementDecision({ ...base, freeNow: 500, heldTokens: 9000, readTokensPerSecond: 141 });
    assert.equal(no.replace, false);
    assert.match(no.reason, /relecture estimée 64 s/);
  });
  test('nothing held, or no read rate known: the rule is unchanged (REPLACE_MIN_LAYERS)', () => {
    const base = { outcome: 'fallback' as const, gpuLayers: 0, totalLayers: 66, freeAtLoad: 0, loadedVram: 0, bytesPerLayer: 100, freeNow: 400 };
    assert.equal(replacementDecision({ ...base, heldTokens: 0, readTokensPerSecond: 141 }).replace, true);
    assert.equal(replacementDecision({ ...base, heldTokens: 9000, readTokensPerSecond: null }).replace, true);
  });
  ```
  The existing tests in the file pass `heldTokens: 0, readTokensPerSecond: null`. Add that through their shared base object, not per call.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `replacement` and `worker-replacement`. Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1121/1121** (+2).
- [ ] **Step 6: Measure** A on stories260K and the 27B (same session as another task). Expect no regression.
- [ ] **Step 7: Commit:**
  ```
  git add electron/core/local-engine.mts electron/tests/replacement.test.mts tasks/todo.md
  git commit -m "perf: the re-placement between turns asks for one more extra layer per 15 s of conversation it would have to re-read, and says the estimate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 13: A quieter index — incremental, thread-limited, paused during a turn

**Hypothesis.**
- **Incremental.** An unchanged project re-embeds 0 files on re-activation, instead of every file (`semantic-index.mts:76-121` is a full rebuild). Expected: index time −90 % on the second activation [hypothèse].
- **Compact JSON.** Pretty-printed vectors (`json-store.mts:52`) block the worker's event loop longer.
- **Thread limit and pause.** On a CPU-bound model, ONNX threads compete with llama.cpp threads. Expected: with indexing running, A's reading and writing times come within 10 % of a run without indexing [hypothèse].
- Metrics: bench `--project-files 400` (a synthetic project, indexed at activation): `index` duration from the worker's index events, and A's phases.

**Files:**
- Create: `electron/core/index-gate.mts`.
- Modify:
  - `electron/core/semantic-index.mts` (`IndexFile.files` stamps; `indexFolder` options);
  - `electron/core/json-store.mts` (constructor option `indent`);
  - `electron/core/embeddings.mts` (`session_options`);
  - `electron/core/perf-levers.mts`;
  - `electron/worker.mjs` (`triggerIndexing` 154-168 passes the gate; `runSend` pauses and resumes in `finally`);
  - `electron/bench/child.mts` and `run.mts` (`--project-files <n>`; records `indexMs`);
  - tests `semantic-index.test.mts`, `embeddings.test.mts`, `worker-index-status.test.mts`, `perf-levers.test.mts`.

**Interfaces:**
- Produces:
  - `index-gate.mts`:
    ```ts
    export class IndexGate {
      pause(): () => void;                  // a counter; the returned resume is idempotent
      wait(signal?: AbortSignal): Promise<void>;   // resolves at once when not paused, else when the count is back to 0
      get paused(): boolean;
    }
    ```
  - `semantic-index.mts`:
    - `IndexFile` gains `files?: Record<string, { size: number; mtimeMs: number }>`; `INDEX_VERSION` is unchanged and an index without `files` is rebuilt fully;
    - `indexFolder(folder, home, onProgress?, ignoredPatterns?, options?: { gate?: { wait(): Promise<void> } })` awaits `gate.wait()` before each file's `embed`, reuses the entries of a file whose `{size, mtimeMs}` is unchanged, re-embeds a changed one and drops a removed one;
    - it returns `{ chunks: number; embeddedFiles: number; reusedFiles: number }`;
    - the store is written with `new JsonStore({ indent: 0 })`.
  - `JsonStore` gains `constructor(options?: { indent?: number })` (default 2, today's).
  - `embeddings.mts`: `export function sessionOptions(threads: number | null): { intraOpNumThreads?: number; interOpNumThreads?: number }`, passed to `pipeline(..., { session_options })`.
  - `PerfLevers.indexDuringTurns: 'run' | 'pause'` ('run') and `PerfLevers.embedThreads: number | null` (null).
  - The incremental update and the compact JSON are not levers. They preserve results, which the equality test proves, and they ship directly.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `semantic-index.test.mts`:
    - `an unchanged file keeps its vectors without embedding again; a changed file is re-embedded; a removed one is dropped`: `embeddedFiles`/`reusedFiles` exact after touching one file of three and deleting one;
    - `an incremental update equals a full rebuild`: the same ids, files and texts, and vectors by cosine ≥ 0.98 (lesson 2026-10-17: quantised embeddings vary with the batch);
    - `an index without file stamps is rebuilt fully`: `reusedFiles === 0`;
    - `indexFolder waits at the gate between files and resumes`: with a paused `IndexGate`, `onProgress` stops at 1 until `resume()`.
  - `embeddings.test.mts`: `sessionOptions(2)` deepEquals `{ intraOpNumThreads: 2, interOpNumThreads: 1 }`, and `sessionOptions(null)` deepEquals `{}`.
  - `worker-index-status.test.mts`, with the lever `indexDuringTurns: 'pause'`:
    - `a send pauses the indexing until the turn ends`: 60 files, then `activate_folder`, then `send` (test provider seam); no `index` progress event between `send-started` and `done`, then `ready`;
    - `a stopped turn resumes the indexing`: the same with `stop` during the turn; `ready` arrives within 60 s.
- [ ] **Step 2: Run** the three files. Expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
  - `runSend` takes `const resume = levers.indexDuringTurns === 'pause' ? indexGate.pause() : () => {}` before `phase('preparing')`, and calls `resume()` first in its `finally`.
  - Compaction does the same.
- [ ] **Step 4: Run** the three files, plus `search-tools`, `worker-search-tools`, `knowledge-base` and `worker-knowledge`. Expect PASS.
- [ ] **Step 5: Start-up audit** (global constraint), then the full suite, alone. Expect **1128/1128** (+7: semantic-index 4, embeddings 1, worker-index-status 2).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/index-gate.mts electron/core/semantic-index.mts electron/core/json-store.mts electron/core/embeddings.mts electron/core/perf-levers.mts electron/worker.mjs electron/bench/child.mts electron/bench/run.mts electron/tests/semantic-index.test.mts electron/tests/embeddings.test.mts electron/tests/worker-index-status.test.mts electron/tests/perf-levers.test.mts
  git commit -m "perf: the semantic index updates only changed files and writes compact JSON; levers to pause it during a turn and to cap its ONNX threads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure** `--project-files 400 --scenarios A` on both models:
  - « avant » = HEAD~1 in a temporary worktree (incremental absent) with shipped levers;
  - « après » = this commit, first with shipped levers (incremental and compact only), then `indexDuringTurns=pause`, then `embedThreads=2`.
- [ ] **Step 8: Keep or revert.**
  - The incremental and compact changes are reverted only on a regression.
  - Each lever follows the rule. If `pause` is kept, `index-status-visual.cjs` goes on the Task 15 list.

## Task 14: MCP servers kept alive

**Hypothesis.**
- Today every turn spawns each stdio server, initialises it, lists its tools and closes it, and every call spawns it again (`mcp-client.mts:241-307`).
- Keeping one live session per server turns the per-turn discovery into one `tools/list` on a live process.
- Expected: A·2–A·4's `preparing` with a server that takes 1.5 s to start goes from ≥ 1 500 ms to < 100 ms, and a tool call no longer pays the start-up [hypothèse].
- Without MCP servers there is no gain. The bench measures it with `--mcp-fake 1500`.

**Files:**
- Modify:
  - `electron/core/mcp-client.mts` (`McpPool`; `mcpTools` and `toAgentTool.execute` take the pool);
  - `electron/core/perf-levers.mts`;
  - `electron/worker.mjs`:
    - `nonPluginTools` :350;
    - `mcp-remove` :1129;
    - `trust-project`/withdrawal :1119;
    - the shutdown path, which calls `pool.closeAll()` beside `stopAllMcpServers`;
  - `electron/bench/child.mts` and `run.mts` (`--mcp-fake <ms>`: a global entry for `tests/fixtures/fake-mcp-server.cjs` with `FAKE_MCP_INIT_DELAY_MS`);
  - tests `mcp-client.test.mts`, `worker-mcp.test.mts`.

**Interfaces:**
- Produces:
  ```ts
  export class McpPool {
    constructor(options?: { idleMs?: number });   // default 600_000: a session unused that long is closed
    session(target: McpTarget, timeoutMs: number): Promise<Session>;   // live session for this exact target (key = JSON of the target), opened and initialised once; a dead one is reopened
    closeWhere(predicate: (target: McpTarget) => boolean): Promise<void>;
    closeAll(): Promise<void>;
  }
  // mcpTools(targets, options & { pool?: McpPool }): with a pool, discovery is `tools/list` on pool.session(...) and nothing is closed;
  // the tools it returns call through the same pool. Without a pool: exactly today's behaviour.
  ```
  - `PerfLevers.mcpKeepAlive: boolean` (false). The worker passes `pool` only when it is on.
  - A target whose config changed has a new key: the old session is closed by `closeWhere(t => !currentKeys.has(key(t)))` after each discovery.
  - `mcp-remove` and a trust withdrawal call `closeWhere` for that server or that project's servers.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `mcp-client.test.mts`, with `fake-mcp-server.cjs` and `FAKE_MCP_PID_FILE`:
    - `with a pool, two discoveries start the server once`: one line in the PID file;
    - `a tool call reuses the discovery's process`: still one line after `execute`;
    - `a crashed server is started again at the next discovery`: kill the PID, discover, and expect two lines and tools listed;
    - `closeWhere kills the process`: the PID is gone (`process.kill(pid, 0)` throws).
  - `worker-mcp.test.mts`, with the lever on:
    - `mcp-remove and trust withdrawal stop the kept server`: PID gone within 5 s of each op;
    - `shutdown leaves no MCP process`: every PID in the file is gone after `shutdown`.
- [ ] **Step 2: Run** both files. Expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** `mcp-client`, `worker-mcp`, `mcp-config`, `worker-trust` and `worker-turn-log` (test 6, MCP secrets). Expect PASS.
- [ ] **Step 5: Full suite**, alone. Expect **1134/1134** (+6).
- [ ] **Step 6: Commit:**
  ```
  git add electron/core/mcp-client.mts electron/core/perf-levers.mts electron/worker.mjs electron/bench/child.mts electron/bench/run.mts electron/tests/mcp-client.test.mts electron/tests/worker-mcp.test.mts
  git commit -m "perf: lever to keep MCP servers alive between turns and calls — stopped on removal, trust withdrawal, a changed config, 10 min unused and shutdown (shipped off until measured)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```
- [ ] **Step 7: Measure** A with `--mcp-fake 1500` on stories260K and the 27B (`preparing` per message). Also re-measure Task 7's `overlapLoad` with `--mcp-fake 1500` if it was decided without MCP.
- [ ] **Step 8: Keep or revert**, per the rule. If kept, `mcp-visual.cjs` goes on the Task 15 list.

## Task 15: Closure — window tests once, package once, the 27B table, bilan, lessons, BDC, MTP watch

**Files:**
- Modify:
  - `tasks/todo.md` (bilan);
  - `tasks/lessons.md`;
  - `README.md`: one line under the features, « **Réglage « Longueur maximale de la réflexion »** (Réglages › Matériel) : sans limite par défaut. »;
  - this plan (bilan section).
- Fix only what a run proves wrong, in the owning task's spirit, and say so in the bilan.

**Steps:**
- [ ] **Pre-flight**, before any window run:
  - Re-run the full suite alone, behind the guard. Expect **1134** minus the tests of every reverted lever, the sum written in `tasks/todo.md`.
  - `tsc` core (5) and renderer (0), and `npm run renderer:build` (exit 0), each alone.
  - `node --experimental-strip-types --test tests/updater.test.mts` first, since its guard inspects launchers (lesson 2026-10-04).
  - Re-read every `waitFor` added to `hardware-visual.cjs` against its value on the initial state (lessons 2026-10-04, 2026-10-18).
- [ ] **Window tests, ONCE each**, from `electron/`:
  - The form: `node --experimental-strip-types bench/guard.mts && npm run <script> > ../.superpowers/runs/<script>.log 2>&1; echo exit $?`. Then read the log and look at every capture. A failure is reported, never re-run.
  - Always: `test:hardware` (`hardware-visual.cjs`, edited in T9) and `test:settings-tabs` (the Matériel tab grew a row).
  - Added by a kept lever:
    - `test:localmodel` and `test:stop` (`overlapLoad`, T7);
    - `test:indexstatus` (`pause`, T13);
    - `test:mcp` (`mcpKeepAlive`, T14).
  - The `engineAtBoot` case (T7) is covered by `test:hardware`, already listed.
- [ ] **Package, ONCE** (ask the user first: a long run while he may be playing).
  - `npm run package:win > ../.superpowers/runs/package-win.log 2>&1; echo exit $?` exits 0.
  - `app.asar` contains `core/perf-levers.mts`, `core/reuse.mts`, `core/builtin-tools.mts`, `core/prompt-layout.mts` and `core/index-gate.mts`, and no `bench/` and no `tests/`. Check this by listing with `@electron/asar`'s `listPackage` from node, never with the CLI in the repo (lesson 2026-10-21).
  - `npm run test:package > ../.superpowers/runs/test-package.log 2>&1; echo exit $?`.
  - Then `tasklist | grep -i -E "openagent|electron"` must show nothing left.
- [ ] **The 27B before/after table (user present), once.**
  - Run `bench` with every scenario, `--label 27b-final`, on the final build with the shipped levers and the same caps as the reference.
  - Then run `npm run bench:compare -- <27b-reference.json> <27b-final.json>`.
  - The bilan's table has these rows: lecture du message 2 (A·2 `promptMs` and evaluated tokens), tok/s (A·1–A·4 median), chargement à froid (C-froid `loadMs`) and chargement à chaud (C-chaud `loadMs`). Each figure is marked « mesuré », and the caps are stated.
  - If the user is absent, write « non mesuré » and keep the per-task figures already measured.
- [ ] **Static closure checks.**
  - `git diff 87eaa75..HEAD -- electron/core/settings.mts` adds `max_thought_tokens` and removes no key.
  - `tests/tool-contracts.test.mts` passes: no tool removed, no contract weakened.
  - `git diff --stat 87eaa75..HEAD -- electron/package.json` touches only `scripts`.
  - `git grep -n "bench/" -- electron/package.json` shows scripts only, not `build.files`.
  - `git grep -nI -e "Users\\\\" -e "/Users/" -- electron/bench electron/tests/fixtures/tool-contracts.v1.json` prints nothing: no personal path. The plan is left out because it holds this pattern itself.
- [ ] **Bilan in `tasks/todo.md`**, « Bilan du lot — vitesse du LLM local (2026-10-25) »:
  - per spec objective 1–6: the levers, their hypothesis, the figures before and after (« mesuré », with the file names), the decision (gardé / retiré, with the reason) and the commit;
  - the decisions taken on the spec's ambiguities (this plan's Self-Review);
  - the watch item, word for word: « Prédiction multi-jetons : à intégrer quand node-llama-cpp l'exposera ». Add whether the user's 27B file has MTP weights (`architecture.mtpWeights` from Task 2, « mesuré »);
  - what is not proven: the re-placement rule (T12) in a real VRAM change, a machine without NVIDIA, and any lever left « en attente de mesure 27B ».
- [ ] **Lessons.** Add `tasks/lessons.md` lines only for what went wrong in this lot (`date | what | cause | rule`).
- [ ] **BDC.** At the end, propose grouped, verified notes for `D:\BDC` to the user (user memory: BDC at each lot's end), each with how it is known. Candidates, only if confirmed by this lot's runs:
  - node-llama-cpp 3.21.1: a hybrid or recurrent sequence reuses its prefix only through a checkpoint, and the default interval is 8 192;
  - `budgets.thoughtTokens` defaults to 75 % of the context, not unlimited;
  - `JinjaTemplateChatWrapper` merges adjacent system messages;
  - the measured effect of InputLookup on a hybrid model;
  - Windows per-process GPU memory through `typeperf "\GPU Process Memory(pid_*)\…"`.
- [ ] **Commit:**
  ```
  git add README.md tasks/todo.md tasks/lessons.md docs/superpowers/plans/2026-10-25-llm-performance.md <any window test fixed in pre-flight>
  git commit -m "docs: LLM performance delivered — measured levers kept or removed, 27B before/after table, lessons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Obj. 1: reproducible bench, built first; A (3 short messages, empty folder), B (`read_file` on a small provided file), C (cold then warm) | T1 (`bench.test` e2e, scenarios.mts); T2 reference |
| Obj. 1: per-turn load (and its stages), reading, thinking, writing, evaluated vs reused input, tok/s, VRAM and RAM; turn log, `tokenMeter`, `performanceTracking`, `printTimings()`, a per-turn reuse indicator | T1 (`reuse`, `promptMs`, `loadStages`, `architecture`, `sampleMemory`, `[perf]` lines; `worker-turn-log` 7) |
| Obj. 1: stories260K automatic, the 27B manual with the user's consent and no game; a dated results file as reference | T1 (`bench.test`, guard, `resultFileName`, `.superpowers/bench/`); protocol; T2 |
| Obj. 2: measure the real reuse on A·2–A·4 first | T2 (`reuse-report`, 27B reference) |
| Obj. 2: checkpoints after the fixed part, a shorter interval, a memory cap | T3 |
| Obj. 2: keep the previous thought if measured; pass `lastEvaluationContextWindow` / `lastEvaluationMetadata` back | T5 |
| Obj. 2: changing parts after the tools if the model supports it; tool list and order stable | T4 (`toolsAfterSystem` probe, `worker-tools` order test) |
| Obj. 3: shorter descriptions, compact schemas, no tool removed; checked by B and the agent tests | T6 (frozen contracts, size budget, `compactSchema`, B on the 27B, token report) |
| Obj. 4: engine at app start; load beside the tool preparation; numeric remembered layers with explicit `useMmap`; each gain measured | T7, T8 |
| Obj. 5: InputLookup, batch size, threads, q8_0 KV, the reasoning-length setting | T10, T11, T9 |
| Obj. 6: incremental, resource-limited index paused during a turn; MCP kept alive; re-placement weighs the cache cost | T13, T14, T12 |
| Out of scope: MTP, native module changes, the Vulkan spill, projects 2 and 3 | none touched; MTP watch item in T15 |
| Constraints | Global Constraints; the protocol |
| Expected verification: reference file before any lever and one after each kept lever; 27B before/after table (message 2 reading, tok/s, cold and warm load), all « mesuré »; no regression (suite, agent and tool tests, touched window tests once) | T2 reference; each keep step (`27b-t<n>-garde`); T15 |

**Spec ambiguities resolved here:**
1. **« 3 messages courts » vs « du message 2 au message 4 ».** A has 4 messages: a first one and 3 short follow-ups. Reuse is read on 2–4.
2. **Cold and warm start (C).**
   - Cold = a fresh process with a fresh data home. Warm = a second fresh process on the same home, which keeps the remembered layer limit and the OS file cache.
   - Each sends one short message. The OS page cache is not flushed (that would need admin rights), so « froid » is cold for the process, not for the disk.
3. **« Points de sauvegarde juste après la partie fixe ».** They come from node-llama-cpp's interval checkpoints, taken at batch ends: an interval ≤ 1 024 lands one within about one batch of the end of the fixed part. An explicit checkpoint at the prefix end is not planned, because under `maxMemory` the oldest checkpoint is pruned first (`LlamaContextSequenceCheckpoints.js:64-80`). It is a follow-up only if Task 3's figures still show more than one batch re-read.
4. **« Après les outils ».** Adjacent system messages are merged by the Jinja wrapper, so the context goes into a leading user item. This applies only when a probe shows the template renders tools after the system text; « si le modèle supporte ce placement » becomes that probe.
5. **« Sans limite par défaut ».** It means `budgets.thoughtTokens: Infinity`, since node-llama-cpp's own default is 75 % of the context. The setting goes in **Matériel**, justified in Task 9.
6. **27B bench runs are capped** (`outputCap=1024`, `thoughtTokens=512`) to keep them bounded, with the same caps on both sides of every comparison and stated in every table.
7. **Before and after on one build.** Levers default to today's behaviour and are switched by `OPENAGENT_PERF_LEVERS`. « Keep » changes the shipped default; « revert » removes the code and its tests.
8. **What counts as a measured gain.** Token counts: any reduction. Times: ≥ 10 % on the median of the targeted messages, in the same direction on each. Regressions are listed in the protocol.
9. **Unmeasurable by A/B/C.** `lastEvaluationContextWindow` (expected: no gain, since `fitToBudget` prevents shifts) and the re-placement rule (needs a VRAM change) are stated as such. The first is reverted on no gain; the second is kept on tests and no regression.
10. **« VRAM et RAM ».** Per process (lesson 2026-10-21): RSS, the Windows GPU process counters, and node-llama-cpp's `memoryUsage` through the placement. Never the card's global figure.
11. **The results folder.** `.superpowers/bench/`, already git-ignored.
12. **`printTimings()` lines** are forwarded only with `performanceTracking` on, and tied to generations by order (best effort).
13. **What tool slimming may touch.** The « Outils disponibles » line, `additionalProperties`, `required`, types and limits are kept as they are; slimming touches descriptions and schema noise only.

**Step scan:**
- Every step names files, values and commands.
- Algorithms are written out where tests cannot pin them alone: the reuse formula, the phase sums, the guard rule, the placement probe, the numeric-load fallback, the re-placement rule and the pool lifecycle.
- The description rewrites of Task 6 are left to the implementer under explicit rules and a frozen-contract guard.

**Type consistency:**
- `PerfLevers` is defined in T1, and each later task adds keys with a shipped default. `perfLevers()` is used by the engine (T1, T3, T5, T8, T10, T11), the agent (T5) and the worker (T7, T13, T14).
- `ReuseFigures` (T1) is consumed by `bench/metrics.mts` (T1) and `reuse-report.mts` (T2).
- `GenerationStats.promptMs` and `reuse` (T1) are consumed by T12 (`lastReadRate`), and `predictions` (T10) by `bench/metrics.mts`.
- `LoadStage` and `ModelArchitecture` (T1) feed `model-ready` and `TurnFigures`.
- `sequenceOptions` (T3) gains `tokenPredictor` (T10). `contextOptions` (T11) feeds both `createContext` calls. `thoughtBudget` (T9) consumes `levers.thoughtTokens` (T1).
- `builtInTools(folder, dataHome, ignoredPatterns)` and `toolSchemas` (T1) are used by `bench/tool-tokens.mts` (T1) and `tool-contracts` (T6).
- `historyFromMessages` options: `projectContext`/`placement` (T4), plus the `reasoning` segment (T5).
- `buildInstructions` returns `base`/`projectContext` (T4), consumed by `worker.mjs`.
- `IndexGate` (T13) is used by `worker.mjs` and `indexFolder`. `McpPool` (T14) is used by `mcpTools` and `worker.mjs`.

**Counts.** No task removes a test unless a lever is reverted:
- 1079 → 1090 (T1 +11: reuse 3, perf-levers 1, bench-metrics 3, local-engine 1, worker-turn-log 1, bench 2);
- → 1092 (T2 +2: bench-metrics);
- → 1094 (T3 +2: perf-levers 1, local-engine 1);
- → 1100 (T4 +6: prompt-layout 2, local-provider 1, agent 1, worker-tools 1, context 1);
- → 1103 (T5 +3: request-context 1, local-provider 1, local-engine 1);
- → 1107 (T6 +4: tool-contracts 3, local-provider 1);
- → 1110 (T7 +3: worker-engine-start 2, worker-turn-phases 1);
- → 1112 (T8 +2: low-vram-fallback 2);
- → 1115 (T9 +3: local-context 1, local-engine 1, hardware-view 1);
- → 1117 (T10 +2: local-engine 2);
- → 1119 (T11 +2: local-engine 2);
- → 1121 (T12 +2: replacement 2);
- → 1128 (T13 +7: semantic-index 4, embeddings 1, worker-index-status 2);
- → **1134** (T14 +6: mcp-client 4, worker-mcp 2);
- T15 pre-flight: 1134 minus the tests of every reverted lever.
- New imports in `all.mts`: `reuse`, `perf-levers`, `bench-metrics`, `bench` (T1); `prompt-layout` (T4); `tool-contracts` (T6). The other tasks add to existing files.

**Review Focus coverage:**
1. T3, perf-levers « shorter interval needs a memory cap ».
2. T4, prompt-layout « reaches the rendered prompt once » and agent « saved transcript has no context item ».
3. T14, mcp-client « closeWhere » and worker-mcp « removal and withdrawal ».
4. T7, worker-engine-start « shutdown right after start ».
5. T13, worker-index-status « a stopped turn resumes the indexing ».

**Proportion:** the plan holds signatures, pinned values, real failing tests, commands and the measurement protocol. Bodies left out are those the signatures and tests determine. Task 6's text edits are bounded by rules plus a frozen-contract guard rather than written out.
