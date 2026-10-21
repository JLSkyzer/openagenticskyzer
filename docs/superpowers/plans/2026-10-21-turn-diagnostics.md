# Turn Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** During a turn, the chat shows what the model is doing (« Préparation… », « Chargement du modèle… 42 % », « Lecture du message… », « Réflexion… », « Écriture… », « Outil : … », « Arrêt en cours… ») with a running timer. Each reply carries a timing line. The model's reasoning is separated from the answer, kept on the message and shown in a collapsible « Réflexion » block. Stop gives control back during the load, the context creation, an estimate wait and the load lock. Every turn is written to a redacted JSON Lines log. The data folder explains itself with `LISEZMOI.txt`. Four small defects are fixed on the way: horizontal scroll, the empty-chat text, the updater's « Échec » when no release exists, and a CUDA hint on NVIDIA + Vulkan.

**Architecture:**
- **Engine (`core/local-engine.mts`).**
  - The load takes the turn's signal: `loadSignal` and `onLoadProgress` on `loadModel`, `createSignal` on `createContext`.
  - The load lock (`serial`) rejects at once for an aborted signal, and a queued load whose signal aborted never runs.
  - Generation reads `onResponseChunk`. Thought segments go to `onReasoning`. Plain text goes through the app-level splitter `core/reasoning-split.mts`, which recovers a `<think>…</think>` pair or a bare `</think>` left in the text.
  - The returned message carries `reasoning` and `reasoningMs`. `onStats` reports tokens and generation time.
  - Each load logs the resolved chat wrapper and its segment settings.
- **Agent loop (`core/agent.mts`).** Forwards `onReasoning` as `thinking` events and `onStats` as `stats` events. Nothing else changes.
- **Worker (`worker.mjs`).**
  - Phases: maps engine and agent events to `phase` events. A `TurnClock` (`core/turn-clock.mts`, pure) measures the timing, joined to `done` and `stopped` and saved on the run's last assistant message.
  - Stop: the `stop` op posts `phase: stopping` at once. `windowFor` races `estimateJobs.idle()` against the signal and passes the signal to the load.
  - Log: a `TurnLog` (`core/turn-log.mts`) writes one JSON line per event to `<dataHome>/logs/turns/AAAA-MM-JJ.jsonl`. It redacts first, then strips contents (`metadata`) or truncates them (`full`). Retention is pruned at worker start.
  - Start-up: the worker also creates the missing data folders and rewrites `LISEZMOI.txt` (`core/data-folders.mts`).
- **Renderer.**
  - State: the reducer gains `phase`, `turnStartedAt`, `stopping`, `streamingReasoning` and `runStartIndex`.
  - Pure labels live in `state/turn-status.ts`.
  - Components: `TurnStatus.tsx` replaces the typing dots. `ReasoningBlock.tsx` and a timing line are added to `AssistantBubble`. The stop button is disabled while stopping.
  - Settings › Général gets the `turn_log` select and « Ouvrir le dossier des journaux », answered by main (`open-turn-logs` → `shell.openPath`).

**Tech Stack:**
- Electron 44, Node 24 (`--experimental-strip-types`, `node:test`, `worker_threads`).
- node-llama-cpp **3.21.1**. Checked on 2026-10-21 in `node_modules`:
  - `LlamaModelOptions.onLoadProgress` and `loadSignal`: `LlamaModel.d.ts:167,169`; `loadModel` throws `loadSignal.reason`: `LlamaModel.js:597-614`.
  - `createSignal`: `LlamaContext/types.d.ts:164`; it throws `createSignal.reason`: `LlamaContext.js:710-748`.
  - `onResponseChunk` with `{type:'segment', segmentType, text, tokens, segmentStartTime?, segmentEndTime?}` or `{type: undefined, text, tokens}`: `LlamaChat.d.ts:21-60,126`.
  - `LlamaChat.chatWrapper` and `.sequence`: `LlamaChat.d.ts:437-438`.
  - `LlamaContextSequence.tokenMeter`: `LlamaContext.d.ts:151`.
  - The prefill `sequence.evaluate` takes no signal: `LlamaChat.js:1959`; `ensureNotAborted` runs at `:1165, :1224, :1930, :1987`.
- React 19 + Vite renderer, TypeScript.
- electron-updater: `ERR_UPDATER_NO_PUBLISHED_VERSIONS` and `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` (`GitHubProvider.js:111,173`); `HttpError.statusCode` (`builder-util-runtime/out/httpExecutor.js:73-80`).
- No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-21-turn-diagnostics-design.md` (binding). The code map is `.superpowers/runs/explore-turn-diagnostics.md`. Its line numbers were re-checked at 9d6ebb8 for every line cited below.

## Global Constraints

- Tests are real and red first: « tests réels, rouge d'abord, `stories260K.gguf` comme modèle réel, `OPENAGENT_HOME` isolé ».
- Every worker and window test gets `OPENAGENT_HOME=<mkdtemp>`. `%USERPROFILE%\.openagent` is never read or written.
- Window tests: « une seule fois chacun, sortie complète dans un fichier ».
  - Every `tests/*-visual.cjs` edited by a task is run ONLY in Task 9, once, as `npm run <script> > ../.superpowers/runs/<script>.log 2>&1; echo exit $?`, then the file is read.
  - A failure is reported, never re-run (lessons 2026-10-17, 2026-10-04).
  - No implementing task runs a window test.
- Load: « la suite complète tourne seule, une fois par tâche, au premier plan (l'utilisateur joue sur ce PC) ».
  - Run it alone: never beside `tsc`, a build or another suite (lesson 2026-10-18).
  - Ask before a long packaging run (user memory).
- Public repository: « aucun chemin personnel ». No user path in code, tests, logs committed or the bilan.
- Language: « textes d'interface en français ». Every string a user sees is French and is asserted by its exact value (lesson 2026-10-06).
- Turn log: « il ne doit jamais contenir de secret, ce qui se vérifie par un test qui y injecte des jetons factices ».
- « Aucun outil ni réglage n'est retiré » (user rule). This lot only adds the `turn_log` setting.
- **Known limit, stated wherever stop is touched:** « node-llama-cpp ne permet pas d'interrompre la lecture du prompt (prefill) en cours. Le stop prend alors effet à la fin de cette lecture. » The latency is measured and logged.
- **Verification baselines**, all commands from `electron/`:
  - full suite `node --experimental-strip-types --test tests/all.mts`. The expected count at 9d6ebb8 is **948/948**: 947 passed plus the one test fixed by a reword, and the suite has not been re-run since. Task 1 re-runs it first;
  - `npx tsc --noEmit -p tsconfig.core.json`: **5 pre-existing errors only**;
  - `npx tsc --noEmit -p renderer-src/tsconfig.json`: **0**;
  - `npm run renderer:build`: exit 0.
- **Test counts.** Each task states the suite count after it. A different `# tests` line is explained before moving on, and the explanation is checked against the files (lesson 2026-10-17).
- **Commits.**
  - Each task stages only its own paths, with an explicit `git add <paths>` from the repository root. Never `git add -A` or `git add .`.
  - Never stage the user's unrelated changes:
    - `docs/superpowers/plans/2026-04-27-onboarding-auto.md` and `2026-04-27-semantic-plugins.md` (deleted in the work tree);
    - `docs/superpowers/plans/liste logique à suivre.txt`;
    - `docs/superpowers/plans/OK 2026-04-27-*.md`;
    - `docs/superpowers/plans/2026-09-14-native-desktop-gui.md`, `2026-10-01-mcp-enhancement.md`;
    - `docs/superpowers/specs/2026-09-14-*` (including `2026-09-14-electron-autonomous-design.md`).
  - Every message ends with the trailer paragraph `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a last `-m`.
  - Push after each commit: `git push origin master`.
- **Packaging.** No new `.cjs` beside `main.cjs`, so `build.files` is unchanged. New core modules ship through `core/**/*`.
- **Start-up side effects.** Tasks 4 and 7 add work at worker start: log retention, data folders and `LISEZMOI.txt`. Before committing either, run `git grep -l "worker.mjs" -- electron/tests` and confirm that every test which starts the worker sets `OPENAGENT_HOME` (lesson 2026-09-30).

## Review Focus

1. **A model whose template pre-fills `<think>`** (the 2026-10-21 Qwen3 27B case). The model emits reasoning, then a bare `</think>`, then the answer. The reasoning must leave the answer, both on screen and in the saved message, even when the tag is split across chunks, and it must never be sent back to the model.
   - Pinned by Task 2: `reasoning-split` tests 3 and 4, and `request-context` « never sent ».
   - Checked manually on Qwen3 in Task 9.
2. **A literal tag in a real answer.** Once a first tag has been seen, a later `</think>` or `<think>` in the answer stays text. Before any tag, a stray `</think>` is the documented fallback. Pinned by Task 2, `reasoning-split` test 5.
3. **Stop in every phase.** The phases are preparing, loading, reading (prefill), writing and tool, plus a permission prompt.
   - Expected: the button disables at once and « Arrêt en cours… » shows; `stopped` always arrives; nothing stays half-loaded; the stop latency is logged.
   - Pinned by Task 2 (`local-engine` tests a and b) and by Task 3 (`worker-turn-phases` tests 2, 3 and 4). The existing permission and tool stop tests are kept unchanged (`worker-longrun`, `agent.test.mts`).
   - The prefill limit is documented, not fixed.
4. **Secrets in places nobody planned for.**
   - The places: a token typed by the user, a token in tool arguments or results, an MCP env or header value, the same value after `${VAR}` expansion, the content of `secrets.json` read through `read_file`, and a token cut by the 20 000-character truncation.
   - Pinned by Task 4: `turn-log` tests 3, 4, 5 and 8, and `worker-turn-log` test 1.
5. **A data-folder migration while logs are written.** After `migrate-data-dir`, the old home must keep only `redirect.json` until the restart. The log is suspended, and the new home gets its folders at the next start. Pinned by Task 4, `turn-log` test 7 and `worker-turn-log` test 4.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `electron/tests/support/worker-events.mts` | **create** (T1) | `callWorker`, `recordAgentEvents`, `phasesOf` |
| `electron/core/abortable.mts` | **create** (T2) | `untilAborted(promise, signal)` |
| `electron/core/reasoning-split.mts` | **create** (T2) | pure: streaming `<think>` splitter, `splitReasoning`, `piecesOfChunk` |
| `electron/core/model-types.mts` | modify (T2) | `ChatMessage.reasoning/reasoningMs/timing`; `CompletionOptions.onReasoning/onStats`; `ModelProvider.contextWindow(options?)`; `LoadEvent`, `GenerationStats`, `WindowOptions` |
| `electron/core/local-engine.mts` | modify (T2) | signals, load progress, abortable lock, segments, splitter, stats, wrapper log |
| `electron/core/agent.mts` | modify (T2) | forwards `thinking` and `stats` |
| `electron/core/request-context.mts` | modify (T2) | the current turn's assistant messages are sent without `reasoning`, `reasoningMs` or `timing` |
| `electron/core/turn-clock.mts` | **create** (T3) | pure: `TurnTiming`, `TurnClock` |
| `electron/worker.mjs` | modify (T3, T4, T7) | phases, stop, timing (T3); turn log, retention, suspension (T4); data folders (T7) |
| `electron/core/turn-log.mts` | **create** (T4) | `TurnLog`, redaction, truncation, levels, retention, `mcpSecretValues` |
| `electron/core/settings.mts` | modify (T4) | `turn_log: 'full'` and its rule |
| `renderer-src/src/ipc/types.ts` | modify (T5, T6) | `TurnPhaseName`, `TurnTiming`, the `phase` and `thinking` events, `timing` on `done`/`stopped`, `ChatMessage` fields; `UpdateStatus` `'no-release'` (T8) |
| `renderer-src/src/state/turn-status.ts` | **create** (T5), grows (T6) | pure: `phaseLabel`, `formatDuration`, `formatElapsed`, `timingLine`, `reasoningSummary` |
| `renderer-src/src/state/reducer.ts` | modify (T5, T6) | phase, stopping, timer start (T5); reasoning, timing attachment (T6) |
| `renderer-src/src/state/ChatProvider.tsx` | modify (T5) | `startedAt`, `stop-requested`, `stop-failed` |
| `renderer-src/src/components/TurnStatus.tsx` | **create** (T5) | status line and live timer |
| `renderer-src/src/components/ChatView.tsx`, `InputBar.tsx` | modify (T5, T6, T8) | status line, disabled stop (T5); reasoning, timing (T6); EmptyState prop (T8) |
| `renderer-src/src/components/ReasoningBlock.tsx` | **create** (T6) | « Réflexion » block |
| `renderer-src/src/components/MessageBubble.tsx` | modify (T6, T8) | reasoning, timing (T6); `overflow-wrap` (T8) |
| `electron/core/data-folders.mts` | **create** (T7) | `ensureDataFolders`, `README_TEXT`, `writeReadme`, `DATA_HOME_ENTRIES` |
| `electron/main.cjs`, `renderer-src/src/ipc/bridge.ts` | modify (T7) | op `open-turn-logs` |
| `renderer-src/src/components/settings/general-view.ts` | **create** (T7) | `TURN_LOG_OPTIONS` |
| `renderer-src/src/components/settings/GeneralTab.tsx` | modify (T7, T8) | « Journal des tours », « Ouvrir le dossier des journaux » (T7); « Aucune version publiée pour l’instant » (T8) |
| `renderer-src/src/state/empty-state.ts`, `components/EmptyState.tsx` | create / modify (T8) | the empty-chat text with or without a folder |
| `renderer-src/src/markdown/markdown.css` | modify (T8) | `overflow-wrap: anywhere` |
| `electron/updater.cjs` | modify (T8) | `isNoRelease`, `statusForError`, `logLine` |
| `renderer-src/src/components/settings/hardware-view.ts`, `HardwareTab.tsx` | modify (T8) | `CUDA_ADVICE`, `cudaAdvice` |
| tests (`.test.mts`, **create**) | **create** | `worker-events` (T1), `reasoning-split` (T2), `turn-clock`, `worker-turn-phases` (T3), `turn-log`, `worker-turn-log` (T4), `turn-status` (T5, T6), `data-folders` (T7), `ui-fixes` (T8) |
| tests (`.test.mts`, modify) | modify | `worker-send`, `worker-longrun`, `worker-local-model` (T1); `local-engine`, `request-context`, `agent` (T2); `main-routing` (T7); `updater`, `hardware-view` (T8); `all.mts` |
| window tests | modify, run in T9 | `stop-visual.cjs` (T5); `local-model-visual.cjs` (T5, T6); `chat-visual.cjs` (T6, T8); `settings-tabs-visual.cjs`, `package-smoke.cjs` (T7); `hardware-visual.cjs` (T8) |
| `tasks/todo.md`, `tasks/lessons.md`, this plan | modify (T9) | bilan, lessons |

---

## Task 1: A shared helper for worker agent events

The same `callWorker` / `collectAgentEvents` / `waitUntilDone` code is declared three times: `worker-send.test.mts:12-38`, `worker-longrun.test.mts:12-38` and `worker-local-model.test.mts:11-32`. Every later worker test needs it.

There is also a race. Those tests register their listener after `await callWorker('send')`. Task 3 posts `phase: preparing` right after the `{runId}` reply, and nothing guarantees the continuation runs before the next port message. So the helper records from **before** the send.

**Files:**
- Create: `electron/tests/support/worker-events.mts`, `electron/tests/worker-events.test.mts`.
- Modify: `electron/tests/worker-send.test.mts`, `electron/tests/worker-longrun.test.mts`, `electron/tests/worker-local-model.test.mts` (their local copies replaced by imports; no assertion changed), `electron/tests/all.mts`.

**Interfaces:**
- Produces `tests/support/worker-events.mts`:
  ```ts
  export function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any>;   // rejects with new Error(message.error)
  export interface AgentRecorder {
    of(runId: string): any[];                                   // that run's agent events, in arrival order (a fresh array)
    until(runId: string, options?: { kinds?: readonly string[]; timeoutMs?: number }): Promise<any[]>;
    // resolves with of(runId) once an event whose kind is in kinds (default ['done','error','stopped']) arrived;
    // rejects after timeoutMs (default 120000) with `until(${runId}) timed out; last kind: ${last?.kind ?? 'none'}`
    first(runId: string, predicate: (event: any) => boolean, timeoutMs?: number): Promise<any>;  // same timeout message shape
    stop(): void;                                               // removes the listener
  }
  export function recordAgentEvents(worker: Worker): AgentRecorder;   // every {type:'event', event:'agent'} message, all runIds
  export function phasesOf(events: readonly any[]): string[];          // kind 'phase' → phase names, consecutive duplicates collapsed
  ```

**Steps:**
- [ ] **Pre-flight.** Run the full suite alone. Expect **948/948**, which confirms the reword fix. On any other count, stop and report before touching anything.
- [ ] **Write the failing tests** in `tests/worker-events.test.mts`. Each uses a real `new Worker(<inline source>, { eval: true })` that posts scripted messages, and no mock.
  ```ts
  test('recordAgentEvents catches an event posted right after a reply, and of() keeps one run apart', …)
    // the inline worker answers {id, ok:true, result:{runId:'r1'}} then, synchronously, posts phase 'preparing' for r1,
    // a delta for 'r2', then phase 'loading' ×2 (progress 10, 20), phase 'reading', done for r1
    // const rec = recordAgentEvents(w); await callWorker(w, 'send'); const events = await rec.until('r1');
    // deepEqual(events.map(e => e.kind), ['phase','phase','phase','phase','done']); phasesOf(events) deepEqual ['preparing','loading','reading']
  test('until rejects with the run id and the last kind seen when the end never comes', …)
    // inline worker posts only phase 'loading' for r1; await assert.rejects(rec.until('r1', { timeoutMs: 200 }),
    //   { message: 'until(r1) timed out; last kind: phase' })
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/worker-events.test.mts`. Expect FAIL: `Cannot find module './support/worker-events.mts'`.
- [ ] **Implement** per Interfaces. Then replace the three local copies with imports.
  - `waitUntilDone(events)` becomes `await rec.until(runId)`.
  - `waitDone(worker, runId, events)` becomes `events.push(...await rec.until(runId))`, with `rec` created before the send.
  - Keep every assertion byte-identical.
- [ ] **Run:** the four files, then the full suite alone. Expect PASS: **950/950** (948 + 2).
- [ ] **Commit:**
  ```
  git add electron/tests/support/worker-events.mts electron/tests/worker-events.test.mts electron/tests/worker-send.test.mts electron/tests/worker-longrun.test.mts electron/tests/worker-local-model.test.mts electron/tests/all.mts
  git commit -m "test: one shared helper for worker agent events, recording from before the send" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 2: Engine instrumentation — abortable load, progress, reasoning, stats, wrapper log

**Files:**
- Create: `electron/core/abortable.mts`, `electron/core/reasoning-split.mts`, `electron/tests/reasoning-split.test.mts`.
- Modify: `electron/core/model-types.mts`, `electron/core/local-engine.mts` (`serial` :89-94, `loadLocked` :161-183, `engineFor` :195-198, `engineContextSize` :222-224, `completeLocal` :246-255, `localProvider` :260-269), `electron/core/agent.mts` (:101-104), `electron/core/request-context.mts` (`requestMessages` :57-66), `electron/tests/local-engine.test.mts`, `electron/tests/request-context.test.mts`, `electron/tests/agent.test.mts`, `electron/tests/all.mts`.

**Interfaces:**
- Consumes: nothing from T1 (unit level).
- Produces `core/abortable.mts`:
  ```ts
  export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>;
  // signal absent → promise; already aborted → rejects signal.reason at once; else whichever settles first; the listener is removed
  ```
- Produces `core/model-types.mts` (additions only):
  ```ts
  export interface TurnTiming { loadMs?: number; readMs?: number; firstTextMs?: number; totalMs: number; outputTokens?: number; tokensPerSecond?: number }
  // ChatMessage gains: reasoning?: string; reasoningMs?: number; timing?: TurnTiming   (never sent to a model)
  export interface ChatWrapperInfo { name: string; segments: unknown }
  export type LoadEvent = { kind: 'start' } | { kind: 'progress'; progress: number } | { kind: 'end'; ms: number; wrapper: ChatWrapperInfo };
  export interface GenerationStats { inputTokens: number; outputTokens: number; generationMs: number }
  export interface WindowOptions { signal?: AbortSignal; onLoad?: (event: LoadEvent) => void }
  // CompletionOptions gains: onReasoning?: (piece: { text: string; moved?: true }) => void; onStats?: (stats: GenerationStats) => void
  // ModelProvider.contextWindow(options?: WindowOptions): Promise<number>   (the test provider ignores the argument)
  ```
- Produces `core/reasoning-split.mts` (pure, no import):
  ```ts
  export type SplitPiece = { kind: 'text'; text: string } | { kind: 'thought'; text: string } | { kind: 'moved'; text: string };
  export class ReasoningSplitter {
    push(chunk: string): SplitPiece[];
    end(): SplitPiece[];
    get text(): string;        // the answer so far: text pieces minus what 'moved' took back
    get reasoning(): string;   // thought + moved pieces so far
  }
  export function splitReasoning(full: string): { reasoning: string; text: string };   // = one push(full) + end()
  export function piecesOfChunk(chunk: { type?: 'segment'; segmentType?: string; text: string }, splitter: ReasoningSplitter): SplitPiece[];
  // type 'segment' (segmentType 'thought' or 'comment') → [{kind:'thought', text}]; type undefined → splitter.push(text)
  ```
  The splitter rules decide what the tests can only sample, so they are written out here:
  - The state starts in `text`, with `sawTag = false`.
  - In `text`, `<think>` switches to `thought`.
  - In `thought`, `</think>` switches back to `text`.
  - The first `</think>` met in `text` while `sawTag` is false emits `{kind:'moved', text: <all text emitted so far by this splitter>}`. The text since the last emission becomes a `thought` piece.
  - Any tag sets `sawTag`. After that, a `</think>` met in `text` is literal text.
  - A chunk's tail that is a proper prefix of `<think>` or `</think>` is held back until the next push.
  - `end()` flushes the held tail as the current state's kind. An unterminated `<think>` leaves its content as reasoning.
  - Empty pieces are never emitted. The tags themselves are never part of a piece.
- `core/local-engine.mts` produces (existing signatures extended, defaults keep every current caller valid):
  ```ts
  export interface EngineOptions extends WindowOptions {}
  export async function loadLocalModel(modelPath: string, contextSize: number, options?: EngineOptions): Promise<Placement>;
  export async function engineContextSize(modelPath: string, request?: ContextRequest, options?: EngineOptions): Promise<number>;
  export function loadedChatWrapper(modelPath: string): ChatWrapperInfo | null;
  export function chatWrapperLogLine(info: ChatWrapperInfo): string;   // `[chat] wrapper ${name} · segments ${JSON.stringify(segments ?? null)}`
  ```
  Behaviour:
  - `serial(run, signal?)`. The queued run starts with `signal?.throwIfAborted()`. The caller gets `untilAborted(result, signal)`. `lock = result.catch(() => undefined)` stays as it is.
  - `loadLocked(path, size, options)` starts with `signal?.throwIfAborted()`, also on the warm path.
  - `onLoad({kind:'start'})` fires only when a real load starts.
  - `loadModel` gets `{ …, loadSignal: signal, onLoadProgress: p => onLoad?.({ kind: 'progress', progress: p }) }`.
  - `createContext` gets `{ …, createSignal: signal }`.
  - After the `[placement]` line, `console.info(chatWrapperLogLine(info))` runs, with `info = { name: chat.chatWrapper.wrapperName, segments: chat.chatWrapper.settings.segments }`. Then `onLoad({kind:'end', ms, wrapper: info})`.
  - In `catch`, when `signal?.aborted`, it rethrows `signal.reason`: a `DOMException` `AbortError`, whatever class node-llama-cpp threw. The worker's `error?.name === 'AbortError'` test depends on that.
  - `engineFor(path, request, options)` passes the options through.
  - `completeLocal`:
    - calls `engineFor(…, { signal: options.signal })`;
    - uses `onResponseChunk` instead of `onTextChunk`, with every chunk going through `piecesOfChunk`: `text` → `onDelta`, `thought` and `moved` → `onReasoning` (`moved: true` for moved);
    - counts `outputTokens` as the sum of `chunk.tokens.length`;
    - takes `inputTokens` from `chat.sequence.tokenMeter` (`diff` of `getState()` taken before the call);
    - measures `generationMs` from the first chunk to the end;
    - calls `onStats` once, in a `finally`, so a stopped generation still reports;
    - sets the content from `splitter.text` after `end()`;
    - sets `reasoning` and `reasoningMs` only when the reasoning is non-empty. `reasoningMs` runs from the first thought piece to the first text piece after it, else to the end.
    - `responseToMessage` keeps the `tool_calls` / `truncated` mapping.
  - `localProvider(...).contextWindow` becomes `(options?: WindowOptions) => engineContextSize(modelPath, request, options)`, and `complete` forwards `onReasoning` and `onStats`.
- `core/agent.mts`: `provider.complete({ …, onReasoning: piece => emit?.({ type: 'thinking', ...piece }), onStats: stats => emit?.({ type: 'stats', ...stats }) })`. The reply keeps `reasoning` and `reasoningMs` as returned.
- `core/request-context.mts`: in the current turn, an assistant message goes out without `reasoning`, `reasoningMs` or `timing`, the way `wireToolResult` strips `name` and `category`. Earlier turns already send `{role, content}` only.

**Steps:**
- [ ] **Write the failing tests.** `tests/reasoning-split.test.mts`:
  ```ts
  test('no tags: every chunking passes the text through, with no reasoning', …)
    // 'Il était une fois' split at every index i: concat of text pieces === full; reasoning === ''; no 'moved'
  test('a complete <think>…</think> pair becomes reasoning, the rest stays the answer', …)
    // splitReasoning('<think>je réfléchis</think>Bonjour') deepEqual { reasoning: 'je réfléchis', text: 'Bonjour' }
  test('a bare </think> with no opening tag moves what came before into the reasoning', …)
    // s.push('I think') → [{text:'I think'}]; s.push(' hard</think>Salut') → [{moved:'I think'},{thought:' hard'},{text:'Salut'}];
    // s.text === 'Salut'; s.reasoning === 'I think hard'
  test('tags split across chunks at every position give the same result as the whole string', …)
    // for full of ['x<think>y</think>z', 'r</think>a', '<think>pensée', 'a</thi'] and every 2-way and 3-way split:
    // streamed { text, reasoning } deepEqual splitReasoning(full); and the concat of text pieces minus moved === final text
  test('after a first tag, later tags are literal text; an unterminated <think> stays reasoning; a held partial tag flushes as text', …)
    // splitReasoning('<think>a</think>b </think> c') deepEqual { reasoning: 'a', text: 'b </think> c' }
    // splitReasoning('<think>pensée') deepEqual { reasoning: 'pensée', text: '' }; splitReasoning('a</thi') deepEqual { reasoning: '', text: 'a</thi' }
  test('piecesOfChunk: a thought or comment segment is reasoning, a plain chunk goes through the splitter', …)
    // {type:'segment', segmentType:'thought', text:'p'} → [{kind:'thought', text:'p'}]; 'comment' → same; {text:'t'} → [{kind:'text', text:'t'}]
  ```
  In `tests/local-engine.test.mts`, keep the 15 existing tests and add:
  ```ts
  test('a. an abort during the load rejects with AbortError and leaves nothing loaded: loadSignal is passed', { timeout: 60000 }, …)
    // await disposeEngine(); const before = liveModelCount(); const c = new AbortController(); const seen: number[] = [];
    // await assert.rejects(loadLocalModel(modelPath, 16384, { signal: c.signal, onLoad: e => { if (e.kind === 'progress') { seen.push(e.progress); c.abort(); } } }), { name: 'AbortError' });
    // seen.length >= 1; every value in (0, 1]; warmModelPath() === null; liveModelCount() === before
  test('b. a signal aborted while waiting for the load lock rejects at once; the queued load never runs', { timeout: 120000 }, …)
    // patched = withTrainContext(stories, tmp, 131072); const loads = nativeLoadCount();
    // const first = loadLocalModel(patched, 65536); const c = new AbortController();
    // const second = loadLocalModel(modelPath, 16384, { signal: c.signal }); c.abort();
    // await assert.rejects(second, { name: 'AbortError' }); await first; nativeLoadCount() === loads + 1; warmModelPath() === patched
    // and an already-aborted signal on the warm path rejects too: loadLocalModel(patched, 65536, { signal: AbortSignal.abort() }) rejects AbortError
  test('c. a real load reports start, rising progress ending at 1, then end with its time and chat wrapper; a reused engine reports nothing', { timeout: 60000 }, …)
    // await disposeEngine(); events via localProvider(modelPath).contextWindow({ onLoad: e => events.push(e) });
    // events[0].kind === 'start'; progress values non-decreasing, last === 1; last event { kind: 'end', ms >= 0, wrapper.name non-empty string };
    // deepEqual(loadedChatWrapper(modelPath), lastEvent.wrapper); chatWrapperLogLine({ name: 'Qwen', segments: { thought: { prefix: '<think>' } } }) === '[chat] wrapper Qwen · segments {"thought":{"prefix":"<think>"}}';
    // a second contextWindow({ onLoad }) on the warm engine pushes no event
  test('d. completeLocal reports its stats once, and a plain model gets no reasoning key', { timeout: 60000 }, …)
    // const stats = []; message = await completeLocal({ modelPath, messages: [user 'Once upon a time'], maxTokens: 16, onStats: s => stats.push(s) });
    // stats.length === 1; stats[0].outputTokens between 1 and 16; stats[0].inputTokens > 0; stats[0].generationMs >= 0; 'reasoning' in message === false
  test('e. a stopped generation still reports its stats', { timeout: 60000 }, …)
    // abort at the first onDelta → rejects AbortError; stats.length === 1; stats[0].outputTokens >= 1
  ```
  In `tests/request-context.test.mts`, add:
  ```ts
  test('reasoning, reasoningMs and timing are never sent: not in the current turn, not in earlier turns', …)
    // requestMessages([user, assistant{content:'a', reasoning:'r', reasoningMs:5, timing:{totalMs:1}}, user, assistant{content:'b', tool_calls:[…], reasoning:'r2'}, tool])
    // no message of the result has a 'reasoning', 'reasoningMs' or 'timing' key; contents unchanged
  ```
  In `tests/agent.test.mts`, add:
  ```ts
  test('runAgent forwards the provider\'s reasoning and stats as thinking and stats events, and keeps reasoning on the reply', …)
    // provider.complete calls options.onReasoning({ text: 'pensée' }), options.onReasoning({ text: 'avant', moved: true }), options.onDelta('réponse'),
    // options.onStats({ inputTokens: 3, outputTokens: 2, generationMs: 5 }) and returns { role: 'assistant', content: 'réponse', reasoning: 'avantpensée', reasoningMs: 7 };
    // emitted types (minus 'turn') deepEqual ['thinking','thinking','delta','stats','message']; the moved one has moved: true; result[1].reasoning === 'avantpensée'
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/reasoning-split.test.mts tests/local-engine.test.mts tests/request-context.test.mts tests/agent.test.mts`.
  - Expect FAIL: the missing module, then:
    - a: the load resolves;
    - b: `second` resolves;
    - c: no event;
    - d and e: `stats.length === 0`;
    - request-context: a `reasoning` key is present;
    - agent: no `thinking` event.
  - If test a's abort lands after node-llama-cpp's last check, record the exact outcome in the bilan and stop. It must not be weakened: `LlamaModel.js:611-614` re-checks the signal after the native load, so a rejection is expected.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the four files, then the full suite alone. Expect PASS: **963/963** (950 + 6 + 5 + 1 + 1). Then both `tsc` (core 5, renderer 0) and `npm run renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/abortable.mts electron/core/reasoning-split.mts electron/core/model-types.mts electron/core/local-engine.mts electron/core/agent.mts electron/core/request-context.mts electron/tests/reasoning-split.test.mts electron/tests/local-engine.test.mts electron/tests/request-context.test.mts electron/tests/agent.test.mts electron/tests/all.mts
  git commit -m "feat: the engine honours a stop during the load, reports load progress, separates the reasoning (thought segments plus a </think> fallback), reports its stats and logs its chat wrapper" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 3: Worker phases, a stop that answers at once, and the turn timing

**Known limit (spec objective 4), restated for the implementer and the bilan:** node-llama-cpp 3.21.1 evaluates the prompt (`sequence.evaluate`, `LlamaChat.js:1959`) without a signal. `ensureNotAborted` runs only after it, at `:1930` and then per token at `:1987`. A stop during `reading` therefore takes effect when the prefill ends. The worker posts `stopping` at once, the button stays disabled until `stopped`, and the latency is measured. Task 4 logs it.

**Files:**
- Create: `electron/core/turn-clock.mts`, `electron/tests/turn-clock.test.mts`, `electron/tests/worker-turn-phases.test.mts`.
- Modify: `electron/worker.mjs`, as follows; `electron/tests/all.mts`.
  - `windowFor` :198-206 and its two callers, :227 and :607;
  - `runSend` :555-647: `active.set` :558, `emit` :589-599, `finish` :563-566, `catch` :616-643;
  - the `stop` op :848.

**Interfaces:**
- Consumes:
  - `recordAgentEvents`, `phasesOf`, `callWorker` (T1);
  - `WindowOptions`, `LoadEvent`, `GenerationStats`, `TurnTiming` (T2);
  - `untilAborted` (T2);
  - `provider.contextWindow(options)` (T2);
  - the agent events `thinking` `{text, moved?}` and `stats` `{inputTokens, outputTokens, generationMs}` (T2).
- Produces `core/turn-clock.mts` (pure; `now` injectable):
  ```ts
  export type { TurnTiming } from './model-types.mts';
  export class TurnClock {
    constructor(startedAt: number, now?: () => number);
    loadStart(): void; loadEnd(): void;               // loadMs = end − start, only once loadEnd ran
    readStart(): void;                                 // the first call is the read start
    chunk(kind: 'thought' | 'text'): void;            // the first chunk ends readMs; the first 'text' sets firstTextMs = t − startedAt
    stats(stats: GenerationStats): void;              // sums outputTokens and generationMs over the steps
    timing(): TurnTiming;                             // totalMs = now − startedAt; tokensPerSecond = round1(outputTokens / (generationMs / 1000)), only when both > 0
  }
  ```
  `readMs` runs from the first `readStart` to the first chunk. It is absent when no chunk came (a stop during loading or prefill). `outputTokens` and `tokensPerSecond` are absent when no `stats` came (the scripted test provider).
- Produces the agent events (exact shapes, all with `{type:'event', event:'agent', runId}`):
  ```ts
  { kind: 'phase', phase: 'preparing' | 'loading' | 'reading' | 'thinking' | 'writing' | 'tool' | 'stopping', progress?: number, tool?: string }
  // progress: integer percent 0–100, only on 'loading', posted when Math.floor(p * 100) changes; tool: only on 'tool'
  { kind: 'thinking', text: string, moved?: true }
  { kind: 'done', summary: string, timing: TurnTiming, longRunning?: true, durationMs?: number }
  { kind: 'stopped', timing: TurnTiming }
  ```
  `stats` events are consumed by the worker and never posted. `turn`, `delta`, `message`, `tool-start`, `permission-request`, `error`, `compacted` and `compact-failed` are unchanged.
- Phase rules in `runSend`:
  - `preparing` is posted before `conversations.messages`.
  - `onLoad` `start` → `loading`; `progress` → `loading` + `progress`.
  - Agent `turn` → `reading` and `clock.readStart()`.
  - First `thinking` after another phase → `thinking`. First `delta` after another phase → `writing`.
  - `tool-start` → `tool` + `tool`.
  - Every phase post is skipped when equal to the last one (same phase, progress and tool). After `stopping`, no phase is posted.
- Stop:
  - `active.set(runId, { controller, folder, kind: 'send', post, stopRequestedAt: null })`.
  - The `stop` op, for a `send` run: sets `stopRequestedAt ??= Date.now()`, posts `{kind:'phase', phase:'stopping'}`, then aborts. A compaction run is only aborted, as today.
  - `windowFor(provider, maxTokens, options = {})`: `estimateJobs.cancelAll(); await untilAborted(estimateJobs.idle(), options.signal); return effectiveWindow(await provider.contextWindow(options), maxTokens)`.
  - `runSend` passes `{ signal, onLoad }`. `runCompaction` passes `{ signal: active.get(compactionId).controller.signal }`.
- Timing and reasoning on the saved messages:
  - `emit` tracks `partialReasoning` beside `partialText`. A `moved` piece empties `partialText` and appends to `partialReasoning`. Both reset on an assistant `message`.
  - On `done`: `timing` goes on the last assistant message of `result` at an index ≥ `collected.length`, before `conversations.save`.
  - On abort: the partial message is `{ role: 'assistant', content: partialText, ...(partialReasoning.trim() ? { reasoning: partialReasoning } : {}) }`. It is kept when either part is non-blank, and `timing` goes on the last assistant of `produced`. A run that produced no assistant message saves no timing; Task 4 logs it.
  - `finish('done', { summary, timing })` and `post({ kind: 'stopped', timing })`.

**Steps:**
- [ ] **Write the failing tests.** `tests/turn-clock.test.mts` (fake clock `let t = 1000; const now = () => t`):
  ```ts
  test('TurnClock: load, read, first thought then first text, stats over two steps', …)
    // start 1000; loadStart@1000 loadEnd@36000; readStart@36100; chunk('thought')@40000; chunk('text')@41200; stats({…, outputTokens: 50, generationMs: 4000}); stats({…, outputTokens: 33, generationMs: 6000}); t = 13800 + 35000
    // deepEqual timing() { loadMs: 35000, readMs: 3900, firstTextMs: 40200, totalMs: 47800, outputTokens: 83, tokensPerSecond: 8.3 }
  test('TurnClock: a stop during the load has only totalMs; a warm turn has no loadMs', …)
    // loadStart only → deepEqual { totalMs: … }; readStart + chunk('text') with no load → no 'loadMs' key, no 'outputTokens' key
  ```
  `tests/worker-turn-phases.test.mts`: real `worker.mjs`, mkdtemp home, `stories260K.gguf` copied and activated as in `worker-local-model.test.mts::setup`, `recordAgentEvents` created before every send.
  ```ts
  test('1. a stories260K turn: preparing → loading → reading → writing, then done with its timing, saved on the reply', { timeout: 180000 }, …)
    // phasesOf(events) deepEqual ['preparing','loading','reading','writing']; the loading events' progress is non-decreasing and the last is 100;
    // done.timing: loadMs > 0, readMs >= 0, firstTextMs > 0, totalMs >= firstTextMs, outputTokens > 0, tokensPerSecond > 0;
    // (await callWorker('messages')) [1].timing deepEqual done.timing
  test('2. a stop during writing: stopping at once, stopped with timing, the partial reply saved with it; latency measured', { timeout: 180000 }, …)
    // first('delta') → const t0 = Date.now(); callWorker('stop'); const end = await until(runId); latency = Date.now() − t0;
    // phasesOf ends with ['writing','stopping']; the 'stopping' phase arrives before 'stopped'; stopped.timing.firstTextMs > 0;
    // saved[1].timing deepEqual stopped.timing; assert.ok(latency < 5000, `stop latency ${latency} ms`); t.diagnostic(`stop latency ${latency} ms`)
  test('3. a stop during the load abandons it: no reading, nothing loaded afterwards', { timeout: 180000 }, …)
    // model = withTrainContext copy at 131072, local_context 'max' (a slower context creation); first(e => e.kind === 'phase' && e.phase === 'loading') → stop;
    // phases include 'loading', end with 'stopping', never 'reading'; stopped.timing has no readMs and no loadMs;
    // (await callWorker('model-status')).loaded === false; nothing saved but the user message
  test('4. a stop right after the send, while preparing: stopped, the model never loads', { timeout: 60000 }, …)
    // stop as soon as callWorker('send') resolves; phases end with 'stopping' and contain no 'reading'; model-status loaded === false
  test('5. with the scripted provider, a tool turn: preparing → reading → tool → reading → writing; the tool phase names the tool', { timeout: 30000 }, …)
    // fake 127.0.0.1 server answering SSE (as test-model-provider.mts::read expects): step 1 a create_file call with no content, step 2 text;
    // phasesOf deepEqual ['preparing','reading','tool','reading','writing']; the tool phase has tool === 'create_file';
    // done.timing has firstTextMs and no outputTokens (the scripted provider reports no stats)
  ```
  Tests 3 and 4 race a real load or preparation against a message. If one of them fails because the work finished first, report it with the event list. Do not loosen it. Lesson 2026-09-20: capture the diagnostic before any re-run.
- [ ] **Run:** `node --experimental-strip-types --test tests/turn-clock.test.mts tests/worker-turn-phases.test.mts`. Expect FAIL: the missing module, then `phasesOf(...)` gives `[]`.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** both files plus `tests/worker-longrun.test.mts`, `tests/worker-local-model.test.mts` and `tests/worker-compact.test.mts`, then the full suite alone. Expect PASS: **970/970** (963 + 2 + 5). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/turn-clock.mts electron/worker.mjs electron/tests/turn-clock.test.mts electron/tests/worker-turn-phases.test.mts electron/tests/all.mts
  git commit -m "feat: the worker posts each turn phase, answers a stop at once with « stopping » and honours it during the estimate wait and the load, and joins the turn timing to done and stopped and to the saved reply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 4: The turn log — JSON Lines per day, redacted, three levels, 14 days

**Decision on retention vs lesson 2026-10-04** (« une purge automatique de données utilisateur déplace dans une archive, jamais `rm` »). The turn log is an app-written diagnostic, not user data: « Pas une sauvegarde … La conversation reste enregistrée dans le projet ». Expired day files are therefore deleted, and only files named exactly `AAAA-MM-JJ.jsonl` inside `logs/turns/`.

**Files:**
- Create: `electron/core/turn-log.mts`, `electron/tests/turn-log.test.mts`, `electron/tests/worker-turn-log.test.mts`.
- Modify: `electron/core/settings.mts` (`globalDefaults.turn_log`, `globalRules.turn_log`), `electron/worker.mjs` (the turn's logger in `runSend`, `pruneTurnLogs` beside `cleanupOldFolders` at :151, `turnLog.suspend()` after a successful `migrate-data-dir`), `electron/tests/all.mts`.

**Interfaces:**
- Consumes:
  - `TurnClock`, `TurnTiming` and the phase rules (T3);
  - `isSensitiveFile`, `protectedPathMatcher` (`core/file-filter.mts:15,24`);
  - `McpServerConfig`, `expandServerPlaceholders` (`core/mcp-config.mts:24,150`);
  - `turnModelStatus` (`core/active-model.mts`);
  - `loadedChatWrapper` (T2).
- Produces `core/turn-log.mts`:
  ```ts
  export const TURN_LOG_LEVELS = ['full', 'metadata', 'off'] as const;
  export type TurnLogLevel = typeof TURN_LOG_LEVELS[number];
  export const TURN_LOG_FIELD_LIMIT = 20_000;
  export const TURN_LOG_RETENTION_DAYS = 14;
  export const MASK = '[masqué]';
  export const SENSITIVE_FILE_MASK = '[masqué : fichier sensible]';
  export const CONTENT_FIELDS = ['text', 'reasoning', 'arguments', 'result'] as const;   // dropped by 'metadata'
  export function turnLogDir(dataHome: string): string;                                   // join(dataHome, 'logs', 'turns')
  export function turnLogFile(dataHome: string, at: Date): string;                         // <dir>/<local YYYY-MM-DD>.jsonl
  export function redact(value: unknown, secrets: readonly string[]): unknown;            // deep copy; strings only; keys kept
  export function truncateFields(value: unknown, limit?: number): unknown;                // a string longer than limit → first `limit` chars + `…[tronqué : ${rest} caractères de plus]`
  export function mcpSecretValues(servers: readonly McpServerConfig[], env?: NodeJS.ProcessEnv): string[];
  // every env and headers value, raw and after expandServerPlaceholders, length >= 6, deduplicated
  export type TurnLogEvent =
    | { event: 'turn-start'; model: string | null; text: string; attachments: number; keep?: number }
    | { event: 'model-ready'; backend: string | null; gpuLayers?: number; totalLayers?: number; contextSize: number; wrapper?: string; segments?: unknown; loadMs?: number }
    | { event: 'phase'; phase: string; previous: string | null; previousMs: number | null; progress?: number; tool?: string }
    | { event: 'generation'; step: number; inputTokens: number; outputTokens: number; generationMs: number }
    | { event: 'tool'; tool: string; category?: string; arguments: unknown; durationMs: number; ok: boolean; result: string }
    | { event: 'reply'; step: number; reasoning?: string; text: string; toolCalls: number }
    | { event: 'end'; kind: 'done' | 'stopped' | 'error'; timing: TurnTiming; stopLatencyMs?: number; message?: string };
  export interface TurnLogger { write(event: TurnLogEvent): void; flush(): Promise<void> }  // write never throws; writes are appended in order
  export class TurnLog {
    constructor(dataHome: string, now?: () => Date);
    begin(input: { runId: string; folder: string; level: TurnLogLevel; secrets: readonly string[]; isProtected: (path: string) => boolean }): TurnLogger;
    suspend(): void;   // after a data-folder migration: every logger, existing or new, writes nothing until the worker restarts
  }
  export async function pruneTurnLogs(dataHome: string, now: Date, days?: number): Promise<string[]>;  // the removed file names
  ```
  - **Line:** `JSON.stringify({ at: now().toISOString(), runId, folder, ...event }) + '\n'`, appended with `appendFile`. The directory is created on the first write. Level `off` creates nothing.
  - **Pipeline, in this order, applied by `write`:**
    1. A `tool` event whose `arguments.path` is a string with `isProtected(path)` true gets `arguments: { path }` and `result: SENSITIVE_FILE_MASK`.
    2. `redact`: every exact secret is replaced by `MASK` through `split(secret).join(MASK)`, never `replace` with a string (lesson 2026-09-22). Then the token patterns, each replaced by `MASK`:
       ```
       /\bhf_[A-Za-z0-9]{20,}/g   /\bgh[pousr]_[A-Za-z0-9]{20,}/g   /\bgithub_pat_[A-Za-z0-9_]{20,}/g
       /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g   /\bxox[abprs]-[A-Za-z0-9-]{10,}/g   /\bAKIA[0-9A-Z]{16}\b/g   /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/gi
       ```
    3. Level `metadata` deletes the `CONTENT_FIELDS` keys. Level `full` applies `truncateFields`.

    Redaction comes first, so a token cut by the truncation is already masked (lesson 2026-10-02, a pair of fixes tested together).
  - **Errors:** an I/O failure of a write is reported once per logger with `console.error('[turn-log] …')` and never reaches the turn.
- `core/settings.mts`: `turn_log: 'full' as TurnLogLevel` in `globalDefaults`; `turn_log: choice('full', 'metadata', 'off')` in `globalRules`.
- Worker wiring in `runSend`:
  - **Logger.** `logger = turnLog.begin({ runId, folder, level: global.turn_log, secrets: [hf_token, ...mcpSecretValues(await mcpServersFor(folder, projectTrust))].filter(Boolean), isProtected })`.
    - `isProtected` is `path => isSensitiveFile(path) || protectedPathMatcher(effective.ignored_patterns)(relative(folder, resolve(folder, path)))`.
    - `secrets` and `isProtected` are built once `registerTools` has returned `effective`. Events before that point are written after it, from a small queue.
  - **Lines.**
    - `turn-start`: at the start, with `model?.name ?? null`.
    - `model-ready`: after `postModelStatus`, from `turnModelStatus(model).placement`, `loadedChatWrapper(model.path)` and `clock` `loadMs`.
    - `phase`: on every posted phase.
    - `generation`: on each `stats`.
    - `tool`: on the tool result `message`. It carries the arguments from the calling assistant message, `durationMs` from its `tool-start`, and `ok = !content.startsWith('Erreur : ')`.
    - `reply`: on each assistant `message`.
    - `end`: on done, stopped (with `stopLatencyMs = Date.now() − stopRequestedAt`) and error (with `message`).
  - **End of turn.** `await logger.flush()` runs before `active.delete(runId)`.
  - **Start-up.** `await pruneTurnLogs(dataHome, new Date()).catch(error => console.error('[turn-log] …'))` runs at start.
  - **Migration.** `turnLog.suspend()` runs right after `migrate-data-dir` succeeds.

**Steps:**
- [ ] **Write the failing tests.** `tests/turn-log.test.mts` (mkdtemp home, injected `now`):
  ```ts
  test('1. one JSON line per event in logs/turns/<local day>.jsonl, with at, runId and folder', …)
    // now = new Date(2026, 9, 21, 23, 59) → file '2026-10-21.jsonl'; two writes, flush → 2 lines, JSON.parse each, { at, runId: 'r1', folder: 'C:/p', event: 'turn-start' } fields
  test('2. metadata drops text, reasoning, arguments and result; off writes nothing at all', …)
    // metadata: the reply line has no 'text'/'reasoning' key, the tool line no 'arguments'/'result', durationMs kept;
    // off: after writes and flush, existsSync(turnLogDir(home)) === false
  test('3. full truncates every string field at 20 000 characters, and a token across the cut is masked first', …)
    // text = 'a'.repeat(19_990) + 'ghp_' + 'x'.repeat(36) + 'b'.repeat(100) → line.text.startsWith('a'.repeat(19_990) + '[masqué]'),
    //   line.text.endsWith('caractères de plus]'), !line.text.includes('ghp_'); a 25 000-char result → exactly 20 000 chars then '…[tronqué : 5000 caractères de plus]'
  test('4. no injected token survives, at any level, anywhere in the event', …)
    // fakes = ['hf_' + 'A1'.repeat(17), 'ghp_' + 'b2'.repeat(18), 'github_pat_' + 'C3_'.repeat(10), 'sk-proj-' + 'd4'.repeat(12), 'xoxb-' + '1234567890-abc',
    //   'AKIA' + 'ABCDEFGHIJKLMNOP', 'Bearer ' + 'e5'.repeat(15), 'monSecretHF-777', 'valeur-env-mcp-42'] (the last two given as exact secrets);
    // each placed in text, reasoning, a nested arguments object, a result and an error message; for 'full' and 'metadata':
    // the file contains none of them; it contains '[masqué]'
  test('5. a file tool on a sensitive or protected path keeps the path and masks the arguments and the result', …)
    // isProtected = p => isSensitiveFile(p) || protectedPathMatcher('private/**')(p); paths 'secrets.json', 'cle.pem', '.env.local', 'private/notes.md' → result === SENSITIVE_FILE_MASK,
    //   arguments deepEqual { path }; 'src/app.ts' → result kept
  test('6. pruneTurnLogs removes day files older than 14 days and nothing else', …)
    // files 2026-10-06.jsonl (15 days before 2026-10-21) removed; 2026-10-07.jsonl (14 days) and 2026-10-21.jsonl kept; 'notes.txt', '2026-10-01.json' kept;
    // returned list deepEqual ['2026-10-06.jsonl']; a missing logs/turns resolves []
  test('7. a write never throws; after suspend() nothing is written', …)
    // logs/turns made a FILE → write + flush resolve, console.error called once; suspend() then write → no file created in a fresh home
  test('8. mcpSecretValues: env and headers values, raw and expanded, at least 6 characters', …)
    // [{command:'x', args:[], env:{ K: 'secret-env-1', S: '${OA_TEST_TOKEN}', T: 'short' }}, {url:'http://127.0.0.1:1', headers:{ Authorization: 'Bearer abcdefghij' }}], env { OA_TEST_TOKEN: 'expanded-777' }
    // → contains 'secret-env-1', '${OA_TEST_TOKEN}', 'expanded-777', 'Bearer abcdefghij'; not 'short'
  test('9. turn_log setting: full by default, the three values accepted, anything else refused', …)
    // (await new SettingsService(home).publicGlobal()).turn_log === 'full'; saveGlobal each of TURN_LOG_LEVELS; 'FULL', 'none', null → rejects 'Paramètre invalide : turn_log'
  ```
  `tests/worker-turn-log.test.mts` (real worker, mkdtemp home):
  ```ts
  test('1. no secret reaches the turn log: typed, answered, in tool arguments, in MCP config, in a sensitive file', { timeout: 60000 }, …)
    // before start: home/mcp.json with a stdio entry (a command that exits at once) env { API_KEY: 'mcp-env-secret-4242' } and a remote entry headers { Authorization: 'Bearer mcp-header-secret-4242' };
    // project/secrets.json = '{"k":"file-secret-4242"}'; save hf_token = 'hf_' + 'Z9'.repeat(17);
    // scripted SSE provider: step 1 a read_file call {path:'secrets.json'} and content 'voici ghp_' + 'q'.repeat(36); step 2 text 'sk-' + 'w'.repeat(40);
    // send text containing the hf token, 'github_pat_' + 'e'.repeat(30), 'mcp-env-secret-4242' and 'mcp-header-secret-4242'; until done;
    // the day file exists; none of the 7 values appear; the tool line for read_file has result === '[masqué : fichier sensible]'; lines include turn-start, phase, tool, reply, end
  test('2. a stories260K turn stopped while writing logs model-ready, generation and the stop latency', { timeout: 180000 }, …)
    // model-ready: backend in ['cuda','vulkan','metal','cpu'], contextSize 16384, wrapper non-empty, loadMs > 0;
    // generation: inputTokens > 0, outputTokens > 0; end: kind 'stopped', stopLatencyMs a number >= 0, timing deepEqual the stopped event's
  test('3. turn_log metadata keeps no content; off writes no file; an expired day file is pruned at worker start', { timeout: 60000 }, …)
    // seed logs/turns/2000-01-01.jsonl before start → gone after the first op; metadata turn → no 'text' key in any line;
    // off turn → the day file's line count unchanged
  test('4. after a data-folder migration, a turn writes nothing into the old home', { timeout: 60000 }, …)
    // migrate-data-dir { newDir } (as worker-data-dir.test.mts) → send a scripted turn → until done; readdir(home) deepEqual ['redirect.json']
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/turn-log.test.mts tests/worker-turn-log.test.mts`. Expect FAIL: the missing module, then no day file.
- [ ] **Implement** per Interfaces. Run the start-up audit: `git grep -l "worker.mjs" -- electron/tests`, and check that every hit sets `OPENAGENT_HOME`.
- [ ] **Run:** both files plus `tests/worker-data-dir.test.mts`, `tests/worker-settings.test.mts` and `tests/worker-turn-phases.test.mts`, then the full suite alone. Expect PASS: **983/983** (970 + 9 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/turn-log.mts electron/core/settings.mts electron/worker.mjs electron/tests/turn-log.test.mts electron/tests/worker-turn-log.test.mts electron/tests/all.mts
  git commit -m "feat: every turn is written to logs/turns/<day>.jsonl — phases, model, tokens, tools, reasoning, reply, stop latency — redacted before anything else, full / metadata / off, 14 days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 5: The status line with its live timer, and a stop button that says so

**Files:**
- Create: `electron/renderer-src/src/state/turn-status.ts`, `electron/renderer-src/src/components/TurnStatus.tsx`, `electron/tests/turn-status.test.mts`.
- Modify:
  - renderer: `ipc/types.ts` (`AgentEvent`, :134-165), `state/reducer.ts`, `state/ChatProvider.tsx` (send-started dispatches at :327 and :343, `stopRun` :354), `components/ChatView.tsx` (dots :94-98, scroll deps :23), `components/InputBar.tsx` (:197-205);
  - window tests, run in T9: `electron/tests/stop-visual.cjs`, `electron/tests/local-model-visual.cjs`;
  - `electron/tests/all.mts`.

**Interfaces:**
- Consumes: the `phase` event, plus `done` / `stopped` with `timing` (T3).
- Produces in `ipc/types.ts` (mirrors of `core/model-types.mts` and T3):
  ```ts
  export type TurnPhaseName = 'preparing' | 'loading' | 'reading' | 'thinking' | 'writing' | 'tool' | 'stopping';
  export interface TurnTiming { loadMs?: number; readMs?: number; firstTextMs?: number; totalMs: number; outputTokens?: number; tokensPerSecond?: number }
  // AgentEvent gains:
  //   { type: 'event'; event: 'agent'; runId: string; kind: 'phase'; phase: TurnPhaseName; progress?: number; tool?: string }
  // and 'done' / 'stopped' gain: timing?: TurnTiming   (optional: older reducer tests post them bare)
  ```
- Produces `state/turn-status.ts` (pure, French copy fixed here):
  ```ts
  export interface TurnPhase { phase: TurnPhaseName; progress?: number; tool?: string }
  export function phaseLabel(phase: TurnPhase): string;
  // 'Préparation…' | 'Chargement du modèle…' | `Chargement du modèle… ${progress} %` | 'Lecture du message…' | 'Réflexion…' | 'Écriture…' | `Outil : ${tool}…` | 'Arrêt en cours…'
  export function formatDuration(ms: number): string;
  // < 60 s: seconds with one decimal, decimal comma, ',0' dropped ('4,2 s', '12,8 s', '35 s'); < 1 h: `${m} min ${ss} s` (ss two digits); else `${h} h ${mm} min`
  export function formatElapsed(ms: number): string;   // whole seconds: '0 s', '42 s', '5 min 07 s'
  ```
- `state/reducer.ts`:
  - `ChatState` gains `phase: TurnPhase | null`, `turnStartedAt: number | null` and `stopping: boolean`. Initial values: `null`, `null`, `false`.
  - `send-started` gains an optional `startedAt?: number` and sets `phase: { phase: 'preparing' }`, `turnStartedAt: action.startedAt ?? null` and `stopping: false`.
  - New actions:
    - `{ type: 'stop-requested' }`: `stopping: true`, `phase: { phase: 'stopping' }`. Ignored when no run is active.
    - `{ type: 'stop-failed'; error: string }`: `stopping: false`, `error`.
  - Agent `phase` → `phase`. While `stopping`, any phase other than `stopping` is ignored.
  - `done`, `stopped` and `error` reset `phase`, `turnStartedAt` and `stopping`.
- `ChatProvider.tsx`:
  - both `send-started` dispatches pass `startedAt: Date.now()`;
  - `stopRun` dispatches `stop-requested`, then awaits `stop(runId)`. A rejection dispatches `stop-failed` with `cleanIpcError(error)` (lesson 2026-09-18).
- `TurnStatus.tsx`:
  - `<div data-testid="oa-turn-status" data-phase={phase.phase}>`, holding `<span data-testid="oa-turn-label">{phaseLabel(phase)}</span>` and `<span data-testid="oa-turn-timer">{formatElapsed(now − turnStartedAt)}</span>`;
  - re-rendered by a 1 s `setInterval`, cleared on unmount;
  - the timer is omitted when `turnStartedAt` is null.
- `ChatView.tsx`:
  - `<TurnStatus />` replaces the typing dots under the last message;
  - it shows whenever `state.agentRunning && !state.pendingPermission`. The banner speaks during a prompt, as the dots did;
  - `state.phase` joins the scroll dependencies (lesson 2026-09-21).
- `InputBar.tsx`: `#oa-send-btn` gets `disabled={state.stopping}`; while stopping, `title` and `aria-label` are « Arrêt en cours… ». The `■` / `➤` text is unchanged: `stop-visual.cjs:109,126` asserts it.

**Steps:**
- [ ] **Write the failing tests** in `tests/turn-status.test.mts`:
  ```ts
  test('phaseLabel gives the seven exact French labels', …)
    // the 8 cases above, including loading with progress 42 → 'Chargement du modèle… 42 %' and tool 'internet_search' → 'Outil : internet_search…'
  test('formatDuration and formatElapsed', …)
    // formatDuration: 4200 '4,2 s', 12800 '12,8 s', 35000 '35 s', 312000 '5 min 12 s', 3_725_000 '1 h 02 min';
    // formatElapsed: 0 '0 s', 42_400 '42 s', 307_000 '5 min 07 s'
  test('reducer: send-started starts the timer in preparing; phase events follow the run; a stale run is ignored', …)
    // send-started { startedAt: 1000 } → turnStartedAt 1000, phase { phase: 'preparing' }; phase loading 42 → { phase: 'loading', progress: 42 };
    // a phase for another runId → state unchanged (same object); done → phase null, turnStartedAt null
  test('reducer: stop-requested shows stopping at once and holds it; stopped clears it; stop-failed reports', …)
    // stop-requested → stopping true, phase stopping; a later phase 'writing' → still stopping; stopped → stopping false, agentRunning false;
    // stop-requested with no run → same object; stop-failed { error: 'x' } → stopping false, error 'x'
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/turn-status.test.mts`. Expect FAIL: missing module.
- [ ] **Implement** per Interfaces.
- [ ] **Edit the window tests** (run in T9). For each `waitFor`, first ask what it returns on the initial state (lessons 2026-10-04, 2026-10-18).
  - `stop-visual.cjs`, before the Stop click (around :109–:121):
    - while the slow stream runs, wait for `[data-testid="oa-turn-status"][data-phase="writing"]`. It is absent before the first delta.
    - Assert its rectangle lies inside `#oa-chat-scroll`'s (lesson 2026-09-21).
    - Read `oa-turn-timer` twice, 2.2 s apart, and assert the second differs.
    - Install a `MutationObserver` on `document.body` that records whether `#oa-send-btn` was ever `disabled` and whether `oa-turn-label` ever read « Arrêt en cours… ».
  - `stop-visual.cjs`, after the click: once `➤` is back, assert both records are true, that `#oa-send-btn` is enabled again, and that `oa-turn-status` is gone. Take one capture while stopping, if the observer caught it, and one after.
  - `local-model-visual.cjs`, during the real turn (after the send at :124, before :125):
    - wait for `[data-testid="oa-turn-status"]` with `data-phase` in `loading | reading | writing`, read its label against `/^(Chargement du modèle…( \d+ %)?|Lecture du message…|Écriture…)$/`, and take one capture;
    - after the reply, assert `oa-turn-status` is absent.
- [ ] **Run:** the test file, then the full suite alone. Expect PASS: **987/987** (983 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/renderer-src/src/state/turn-status.ts electron/renderer-src/src/components/TurnStatus.tsx electron/renderer-src/src/ipc/types.ts electron/renderer-src/src/state/reducer.ts electron/renderer-src/src/state/ChatProvider.tsx electron/renderer-src/src/components/ChatView.tsx electron/renderer-src/src/components/InputBar.tsx electron/tests/turn-status.test.mts electron/tests/stop-visual.cjs electron/tests/local-model-visual.cjs electron/tests/all.mts
  git commit -m "feat: a status line with a live timer replaces the typing dots — Préparation, Chargement 42 %, Lecture, Réflexion, Écriture, Outil, Arrêt en cours — and the stop button is disabled until the turn has stopped" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 6: The timing line under each reply and the « Réflexion » block

**Files:**
- Create: `electron/renderer-src/src/components/ReasoningBlock.tsx`.
- Modify:
  - renderer: `ipc/types.ts` (the `thinking` event; `ChatMessage` fields), `state/turn-status.ts`, `state/reducer.ts`, `components/MessageBubble.tsx` (`AssistantBubble`), `components/ChatView.tsx` (:75-84, :93);
  - tests: `electron/tests/turn-status.test.mts`;
  - window tests, run in T9: `electron/tests/local-model-visual.cjs`, `electron/tests/chat-visual.cjs`.

**Interfaces:**
- Consumes:
  - `thinking {text, moved?}`, and the saved `reasoning`, `reasoningMs` and `timing` (T2, T3);
  - `formatDuration`, `TurnTiming` (T5).
- Produces in `ipc/types.ts`:
  ```ts
  // ChatMessage gains: reasoning?: string; reasoningMs?: number; timing?: TurnTiming
  // AgentEvent gains: { type: 'event'; event: 'agent'; runId: string; kind: 'thinking'; text: string; moved?: true }
  ```
- `state/turn-status.ts` adds:
  ```ts
  export function timingLine(timing: TurnTiming): string;
  // parts joined ' · ', each only when its value is defined: `1ᵉʳ mot ${formatDuration(firstTextMs)}`, `total ${formatDuration(totalMs)}`,
  // `${tokensPerSecond with one decimal and a comma} tok/s`, `chargement ${formatDuration(loadMs)}`
  export function reasoningSummary(input: { streaming: boolean; ms?: number }): string;
  // streaming → 'Réflexion…'; ms defined → `Réflexion · ${formatDuration(ms)}`; else 'Réflexion'
  ```
- `state/reducer.ts`:
  - `ChatState` gains `streamingReasoning: string` (initial `''`) and `runStartIndex: number | null`. The latter is the index right after the user message, set by `send-started`.
  - `thinking`: `moved` → `streamingText: ''`, `streamingReasoning += text`; otherwise `streamingReasoning += text`.
  - An assistant `message` empties `streamingReasoning`.
  - `done` / `stopped` with `timing`: put `timing` on the last assistant message at an index ≥ `runStartIndex`, if any. Then reset `streamingReasoning` and `runStartIndex`.
- `ReasoningBlock.tsx`:
  - `<details data-testid="oa-reasoning" open={open} onToggle={…}>`;
  - `<summary data-testid="oa-reasoning-summary">` holds `reasoningSummary(...)`;
  - the body is `<div data-testid="oa-reasoning-text" className="whitespace-pre-wrap text-[11px]" style={{ color: 'var(--text-muted)' }}>`, plain text, never markdown;
  - `open` starts `true` in the streaming bubble, `false` in a finished message, and is the user's afterwards.
- `AssistantBubble`:
  - gains `reasoning?`, `reasoningMs?` and `timing?`;
  - renders `<ReasoningBlock>` above the Markdown when `reasoning` is non-empty;
  - renders `<div data-testid="oa-reply-timing">{timingLine(timing)}</div>` under the bubble when `timing` exists.
- `ChatView.tsx`:
  - an assistant message renders when `content.trim() || reasoning`. `:76` returns null only when both are empty;
  - the streaming bubble renders when `streamingText || streamingReasoning`, with its block open while `phase === 'thinking'`.

**Steps:**
- [ ] **Write the failing tests** (added to `tests/turn-status.test.mts`):
  ```ts
  test('timingLine: the spec example, a warm turn, a turn with no token count', …)
    // { firstTextMs: 4200, totalMs: 12800, tokensPerSecond: 8.3, loadMs: 35000 } → '1ᵉʳ mot 4,2 s · total 12,8 s · 8,3 tok/s · chargement 35 s';
    // without loadMs → '1ᵉʳ mot 4,2 s · total 12,8 s · 8,3 tok/s'; { totalMs: 900 } → 'total 0,9 s'
  test('reasoningSummary', …)   // streaming → 'Réflexion…'; ms 3400 → 'Réflexion · 3,4 s'; neither → 'Réflexion'
  test('reducer: thinking streams the reasoning; a moved piece takes the streamed text back', …)
    // delta 'I think' → streamingText 'I think'; thinking { text: 'I think', moved: true } → streamingText '', streamingReasoning 'I think';
    // thinking ' hard' → 'I think hard'; assistant message → streamingReasoning ''
  test('reducer: the run\'s timing lands on its last reply, never on an earlier turn\'s', …)
    // loaded [user, assistant A]; send-started; messages assistant B (tool call), tool, assistant C; done { timing } → C.timing deepEqual timing, A and B have none;
    // stopped with timing and no assistant in the run → messages unchanged (same array)
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/turn-status.test.mts`. Expect FAIL: `timingLine is not a function`.
- [ ] **Implement** per Interfaces.
- [ ] **Edit the window tests** (run in T9):
  - `local-model-visual.cjs`, after the real reply (:125–:130): `[data-testid="oa-reply-timing"]` matches `/^1ᵉʳ mot .+ s · total .+ s · .+ tok\/s · chargement .+$/` (the first turn loads the model). Take one capture. stories260K never reasons, so assert there is no `oa-reasoning`.
  - `chat-visual.cjs`, a new last step modelled on its seeded legacy conversation (« chat-6-legacy »):
    - seed one user message and one assistant message `{ content: 'Bonjour.', reasoning: 'Je réfléchis en français.', reasoningMs: 3400, timing: { firstTextMs: 4200, totalMs: 12800, tokensPerSecond: 8.3, loadMs: 35000 } }`;
    - open it; `oa-reasoning-summary` is exactly 'Réflexion · 3,4 s' and `oa-reasoning` is not `open`;
    - `oa-reply-timing` is exactly '1ᵉʳ mot 4,2 s · total 12,8 s · 8,3 tok/s · chargement 35 s';
    - click the summary (a real click), wait for `open`, assert `oa-reasoning-text` is exactly 'Je réfléchis en français.' and lies in the viewport;
    - take one capture collapsed and one open.
- [ ] **Run:** the test file, then the full suite alone. Expect PASS: **991/991** (987 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/renderer-src/src/components/ReasoningBlock.tsx electron/renderer-src/src/ipc/types.ts electron/renderer-src/src/state/turn-status.ts electron/renderer-src/src/state/reducer.ts electron/renderer-src/src/components/MessageBubble.tsx electron/renderer-src/src/components/ChatView.tsx electron/tests/turn-status.test.mts electron/tests/local-model-visual.cjs electron/tests/chat-visual.cjs
  git commit -m "feat: each reply shows its timing (1ᵉʳ mot, total, tok/s, chargement) and its reasoning in a « Réflexion » block, open while the model thinks, folded with its duration afterwards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 7: The data folders, `LISEZMOI.txt`, and « Journal des tours » in Réglages › Général

**Files:**
- Create: `electron/core/data-folders.mts`, `electron/renderer-src/src/components/settings/general-view.ts`, `electron/tests/data-folders.test.mts`.
- Modify:
  - `electron/worker.mjs`: `ensureDataFolders` and `writeReadme` at start, beside :151;
  - `electron/main.cjs`: op `open-turn-logs` in `handleBackendRequest` before the allow-list, plus `openTurnLogs` in `module.exports` :408. The data home from `prepareDataHome` (:361) is kept in a module variable;
  - renderer: `ipc/bridge.ts` (`openTurnLogs()`), `components/settings/GeneralTab.tsx` (section « Données & Stockage », :136);
  - tests: `electron/tests/main-routing.test.mts` (`HANDLED_BY_MAIN` :11 and one test);
  - window tests, run in T9: `electron/tests/settings-tabs-visual.cjs`, `electron/tests/package-smoke.cjs`;
  - `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `TURN_LOG_LEVELS`, `TurnLogLevel` and the `turn_log` setting (T4).
- Produces `core/data-folders.mts`:
  ```ts
  export const DATA_FOLDERS = ['knowledge', 'tools', 'logs'] as const;      // created when missing; cuda-pack/ stays its installer's
  export const README_FILE = 'LISEZMOI.txt';
  export const DATA_HOME_ENTRIES: ReadonlyArray<{ name: string; role: string }>;   // the table below, in this order
  export const README_TEXT: string;                                                  // built from DATA_HOME_ENTRIES, os.EOL line ends
  export async function ensureDataFolders(dataHome: string): Promise<string[]>;      // mkdir (non-recursive) of each missing folder; returns the created names
  export async function writeReadme(dataHome: string): Promise<void>;                // writes README_TEXT to <dataHome>/LISEZMOI.txt (temp file + rename), overwriting
  ```
  `README_TEXT` opens with: « Dossier de données d'openagent. Ce fichier est régénéré à chaque démarrage : vos modifications seraient perdues. ». Then one paragraph per entry, as `<name> — <role>`. The roles below decide the content, and the implementer writes them as full French sentences:

  | name | role (what it holds, who writes it, what the user may drop there) |
  |---|---|
  | `config.json` | réglages globaux, écrit par l'app (Réglages) ; contient le jeton Hugging Face s'il est saisi |
  | `*.pre-electron.bak` | copie de sécurité d'un fichier avant sa première réécriture par cette version |
  | `folders.json` | dossiers de projet récents (barre latérale) |
  | `gguf-library.json` | bibliothèque de modèles `.gguf` : chemins seulement, les fichiers ne sont jamais déplacés |
  | `mcp.json` | serveurs MCP globaux (Réglages › Outils) |
  | `prompts.json` | bibliothèque de prompts (`/`) |
  | `trusted-projects.json` | décisions de confiance par projet |
  | `memory.md` | mémoire globale, écrite par les outils de mémoire à la demande |
  | `learnings.jsonl` | apprentissages globaux, lus par l'app |
  | `estimates.v2.json` | estimations de répartition carte / processeur, recalculables |
  | `redirect.json` | présent si le dossier de données a été déplacé : indique où il se trouve |
  | `knowledge/` | base de connaissances (`knowledge.json`), alimentée par Réglages › Connaissances |
  | `tools/` | outils de l'utilisateur : déposez-y des fichiers `.mjs` (et les plugins Python pris en charge) ; ils sont chargés au tour suivant |
  | `cuda-pack/` | pack CUDA optionnel, géré par son installeur (Réglages › Matériel) |
  | `retention-archive/` | conversations archivées par la rétention, jamais supprimées |
  | `logs/turns/` | journal des tours, un fichier par jour, 14 jours ; réglage « Journal des tours » ; pas une sauvegarde |
  | `LISEZMOI.txt` | ce fichier |
  | `<projet>/.openagent/` | par projet : `config.json`, `conversations.json`, `chat_history.json`, `memory.md`, `learnings.jsonl`, `index/`, `trash/`, `tools/` |

- Worker start, after `cleanupOldFolders`: `await ensureDataFolders(dataHome).catch(...)`, then `await writeReadme(dataHome).catch(...)`. Each failure is logged as `[data-home] …` and never stops the worker. No existing file is modified or moved.
- `general-view.ts`: `export const TURN_LOG_OPTIONS: ReadonlyArray<{ value: TurnLogLevel; label: string }> = [{ value: 'full', label: 'Complet (défaut)' }, { value: 'metadata', label: 'Sans contenu' }, { value: 'off', label: 'Désactivé' }]`.
- `GeneralTab.tsx`, section « Données & Stockage »:
  - a `Row` « Journal des tours » with the hint « Complet : tout le tour, textes compris, secrets masqués. Sans contenu : événements et durées seulement. Conservé 14 jours. » and `<select data-setting="turn_log">` from `TURN_LOG_OPTIONS`, bound to the draft;
  - a button « Ouvrir le dossier des journaux » (`data-testid="oa-open-turn-logs"`) calling `openTurnLogs()`. A failure goes through `notify(cleanIpcError(error), 'negative')` (lesson 2026-10-05).
- `main.cjs`:
  ```js
  async function openTurnLogs(dataHome, openPath) // mkdir(join(dataHome, 'logs', 'turns'), { recursive: true }); const error = await openPath(dir); if (error) throw new Error(error); return { opened: true, dir }
  // handleBackendRequest: if (request.op === 'open-turn-logs') return openTurnLogs(startupDataHome, target => shell.openPath(target));
  ```
- `bridge.ts`: `export function openTurnLogs(): Promise<{ opened: boolean }> { return request('open-turn-logs'); }`

**Steps:**
- [ ] **Write the failing tests.** `tests/data-folders.test.mts`:
  ```ts
  test('ensureDataFolders creates knowledge, tools and logs when missing, and touches nothing that exists', …)
    // home with knowledge/knowledge.json ('{"x":1}') and config.json; returns ['tools','logs']; both files byte-equal and mtime unchanged; a second call returns []
  test('LISEZMOI.txt is rewritten at each call and names every entry of the data folder and of a project', …)
    // write 'ancien' first → after writeReadme the file === README_TEXT; for each DATA_HOME_ENTRIES name: README_TEXT.includes(name);
    // README_TEXT includes 'régénéré à chaque démarrage' and '.mjs'
  test('LISEZMOI.txt carries no personal path', …)   // !/[A-Za-z]:\\|\/Users\/|\/home\/|killi/i.test(README_TEXT)
  test('the worker creates the folders and LISEZMOI.txt at start, in the redirected data home only', { timeout: 30000 }, …)
    // defaultHome with redirect.json → dataHome (mkdtemp); start worker with OPENAGENT_HOME=defaultHome; after 'global-settings':
    // dataHome has knowledge, tools, logs, LISEZMOI.txt; readdir(defaultHome) deepEqual ['redirect.json']
  test('TURN_LOG_OPTIONS: the three levels of the setting, in order, in French', …)
    // TURN_LOG_OPTIONS.map(o => o.value) deepEqual [...TURN_LOG_LEVELS]; labels deepEqual ['Complet (défaut)', 'Sans contenu', 'Désactivé']
  ```
  In `tests/main-routing.test.mts`: add `'open-turn-logs'` to `HANDLED_BY_MAIN`, so the existing « every operation the bridge calls is known » test covers the new bridge call. Then add:
  ```ts
  test('open-turn-logs is answered by main: it creates logs/turns and opens exactly that folder', async () => …)
    // isBackendOp('open-turn-logs') === false; mainSource matches /request\.op === 'open-turn-logs'\)/;
    // const opened = []; await main.openTurnLogs(home, async p => { opened.push(p); return ''; }) → opened deepEqual [join(home,'logs','turns')], the dir exists;
    // equal to turnLogDir(home) (core/turn-log.mts)
  test('open-turn-logs reports the opener\'s error', async () => …)
    // openTurnLogs(home, async () => 'Accès refusé') rejects { message: 'Accès refusé' }
  ```
  No test calls the real `shell.openPath` (lesson 2026-09-25: it would open Explorer on the user's machine).
- [ ] **Run:** `node --experimental-strip-types --test tests/data-folders.test.mts tests/main-routing.test.mts`. Expect FAIL: the missing module; `openTurnLogs is not a function`.
- [ ] **Implement** per Interfaces. Run the start-up audit: `git grep -l "worker.mjs" -- electron/tests`. Also look for any test asserting an exact listing of a worker's home (`git grep -n "readdir(home" -- electron/tests`). The current hits are `data-dir.test.mts`, which calls `migrateDataDir` without a worker, and `main-data-home.test.mts`, which calls main's `prepareDataHome`, so neither should change. Confirm by running both.
- [ ] **Edit the window tests** (run in T9):
  - `settings-tabs-visual.cjs`, in its Général steps:
    - `select[data-setting="turn_log"]` shows « Complet (défaut) »;
    - choose `metadata`, press « Enregistrer », then check that `config.json` holds `turn_log: 'metadata'` and that the other keys are unchanged (its existing « exactly the changed keys » rule);
    - assert `[data-testid="oa-open-turn-logs"]` is visible and enabled, and never click it: it opens Explorer;
    - take one capture.
  - `package-smoke.cjs`: after the packaged app is up, its isolated `OPENAGENT_HOME` holds `LISEZMOI.txt`, `knowledge/`, `tools/` and `logs/`. Check how that file builds its home before editing (lesson 2026-10-04).
- [ ] **Run:** the two files, plus `tests/data-dir.test.mts`, `tests/main-data-home.test.mts` and `tests/worker-data-dir.test.mts`, then the full suite alone. Expect PASS: **998/998** (991 + 5 + 2). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/data-folders.mts electron/worker.mjs electron/main.cjs electron/renderer-src/src/ipc/bridge.ts electron/renderer-src/src/components/settings/general-view.ts electron/renderer-src/src/components/settings/GeneralTab.tsx electron/tests/data-folders.test.mts electron/tests/main-routing.test.mts electron/tests/settings-tabs-visual.cjs electron/tests/package-smoke.cjs electron/tests/all.mts
  git commit -m "feat: the data folder explains itself — knowledge, tools and logs created at start, LISEZMOI.txt regenerated — and Réglages › Général gets « Journal des tours » and « Ouvrir le dossier des journaux »" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 8: UI fixes, the updater with no release, and the CUDA hint on NVIDIA + Vulkan

**Files:**
- Create: `electron/renderer-src/src/state/empty-state.ts`, `electron/tests/ui-fixes.test.mts`.
- Modify:
  - renderer:
    - `markdown/markdown.css` (`.oa-markdown`, :3);
    - `components/MessageBubble.tsx` (`UserBubble` :44);
    - `components/EmptyState.tsx` and `components/ChatView.tsx` (:53-56);
    - `components/settings/GeneralTab.tsx` (`updateText`, :14-25);
    - `ipc/types.ts` (`UpdateStatus.status` gains `'no-release'`);
    - `components/settings/hardware-view.ts`, `components/settings/HardwareTab.tsx`;
  - `electron/updater.cjs` (`errorMessage` :37-40, logger :94-99, `on('error')` :107, `check` catch :116);
  - tests: `electron/tests/updater.test.mts`, `electron/tests/hardware-view.test.mts`;
  - window tests, run in T9: `electron/tests/chat-visual.cjs`, `electron/tests/hardware-visual.cjs`;
  - `electron/tests/all.mts`.

**Interfaces:**
- `state/empty-state.ts`: `export function emptyStateText(activeFolder: string | null): string`. It returns « Ouvre un dossier pour commencer. » when null, unchanged, because `restore-folder-visual.cjs:111,128` and `final-e2e-tray.cjs:92` assert it. Otherwise it returns « Écris un message pour commencer. ».
  - `EmptyState({ activeFolder })` renders it with `data-testid="oa-empty-state"`.
  - `ChatView` passes `activeFolder` from `useChat()`.
- CSS:
  - `.oa-markdown { overflow-wrap: anywhere; }`;
  - `UserBubble`'s bubble gets `style={{ overflowWrap: 'anywhere' }}`;
  - the scroll container keeps `overflow-y-auto` and gains `overflow-x-hidden`. `pre` keeps its own `overflow-x: auto` (`markdown.css:34`).
- `updater.cjs` (pure, exported):
  ```js
  const NO_RELEASE = 'Aucune version publiée pour l’instant';
  function isNoRelease(error) // error?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || error?.statusCode === 404 || error?.statusCode === 406
                              // || (error?.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' && /HttpError: 40[46]\b/.test(String(error.message)))
  function statusForError(error) // isNoRelease(error) ? { status: 'no-release' } : { status: 'error', message: errorMessage(error) }
  function logLine(level, message) // a message matching /Unable to find latest version on GitHub|No published versions on GitHub/ with 40[46] (or the second phrase alone)
                                   //   → { level: 'info', text: NO_RELEASE }; else { level, text: message }
  ```
  `on('error')` and the `check()` catch publish `statusForError(error)`. The logger maps every call through `logLine`, so a missing release prints one line, without a stack.
- `GeneralTab.updateText`: `case 'no-release': return 'Aucune version publiée pour l’instant';`. The `error` case is unchanged.
- `hardware-view.ts`:
  ```ts
  export const CUDA_ADVICE = 'Sur les cartes NVIDIA, le pack CUDA est recommandé : avec Vulkan, une partie du modèle peut déborder en mémoire partagée et ralentir fortement les réponses.';
  export function cudaAdvice(info: HardwareInfo): string | null;   // info.backend === 'vulkan' && info.nvidia ? CUDA_ADVICE : null
  ```
  `HardwareTab.tsx` shows it, when non-null, above the CUDA pack block (:204), as `<span data-testid="oa-cuda-advice" className="text-xs text-yellow-600">`.

**Steps:**
- [ ] **Write the failing tests.** `tests/ui-fixes.test.mts`:
  ```ts
  test('emptyStateText: the old text without a folder, an invitation with one', …)
    // null → 'Ouvre un dossier pour commencer.'; 'C:/p' → 'Écris un message pour commencer.'
  test('a long word wraps instead of scrolling the chat sideways: the CSS says so', …)
    // markdown.css: the .oa-markdown block contains 'overflow-wrap: anywhere'; MessageBubble.tsx source contains "overflowWrap: 'anywhere'";
    // ChatView.tsx source contains 'overflow-x-hidden' on oa-chat-scroll   (the window proof is chat-visual, T9)
  ```
  In `tests/updater.test.mts`, add:
  ```ts
  test('no published release (404, 406, no versions) is « no-release », never an error; anything else stays an error', () => …)
    // statusForError({ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: 406 \n"method: GET"\n    at x' })
    //   deepEqual { status: 'no-release' }; { statusCode: 404 } → same; { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' } → same;
    // { statusCode: 500, message: 'HttpError: 500\nstack' } → { status: 'error', message: 'HttpError: 500' }; new Error('getaddrinfo ENOTFOUND github.com') → error
  test('the updater log says « Aucune version publiée pour l’instant » in one line instead of a stack', () => …)
    // logLine('error', 'Error: Error: Unable to find latest version on GitHub (…), please ensure a production release exists: HttpError: 406 \n    at …')
    //   deepEqual { level: 'info', text: 'Aucune version publiée pour l’instant' }; logLine('error', 'Error: boom') deepEqual { level: 'error', text: 'Error: boom' }
  ```
  In `tests/hardware-view.test.mts`, add:
  ```ts
  test('cudaAdvice: only Vulkan on an NVIDIA card', …)
    // vulkan + nvidia → CUDA_ADVICE (exact spec text); cuda + nvidia → null; vulkan + AMD (nvidia false) → null; cpu → null
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/ui-fixes.test.mts tests/updater.test.mts tests/hardware-view.test.mts`. Expect FAIL: missing module; `statusForError is not a function`; `cudaAdvice is not a function`.
- [ ] **Implement** per Interfaces.
- [ ] **Edit the window tests** (run in T9):
  - `chat-visual.cjs`:
    - right after the folder opens, before the first send, `[data-testid="oa-empty-state"]` is exactly « Écris un message pour commencer. ». This differs from the initial state, which has no folder and shows the old text;
    - in its long-content step (« chat-7-long », around :304), send a message holding a 400-character word with no space. Wait for its user bubble, then assert `#oa-chat-scroll`'s `scrollWidth <= clientWidth`, and the same for the reply bubble when the scripted reply repeats the word;
    - take one capture.
  - `hardware-visual.cjs`, after the hardware lines load: let `info = await worker hardware-info`. Then `[data-testid="oa-cuda-advice"]` exists iff `info.backend === 'vulkan' && info.nvidia`, with the exact `CUDA_ADVICE` text when it does. Say in the bilan which branch the user's machine exercised.
- [ ] **Run:** the three files, then the full suite alone. Expect PASS: **1003/1003** (998 + 2 + 2 + 1). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/renderer-src/src/state/empty-state.ts electron/renderer-src/src/components/EmptyState.tsx electron/renderer-src/src/components/ChatView.tsx electron/renderer-src/src/components/MessageBubble.tsx electron/renderer-src/src/markdown/markdown.css electron/renderer-src/src/components/settings/GeneralTab.tsx electron/renderer-src/src/ipc/types.ts electron/renderer-src/src/components/settings/hardware-view.ts electron/renderer-src/src/components/settings/HardwareTab.tsx electron/updater.cjs electron/tests/ui-fixes.test.mts electron/tests/updater.test.mts electron/tests/hardware-view.test.mts electron/tests/chat-visual.cjs electron/tests/hardware-visual.cjs electron/tests/all.mts
  git commit -m "fix: a long word no longer scrolls the chat sideways, an open folder invites a first message, no published release is « Aucune version publiée pour l’instant » instead of an error with a stack, and Matériel recommends the CUDA pack on NVIDIA + Vulkan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 9: Window proofs, packaged app, manual check, closure

**Files:**
- Modify: `tasks/todo.md` (bilan), `tasks/lessons.md`, `README.md` (one line under the features: « **Diagnostic des tours** : statut et chronomètre en direct, temps de chaque réponse, réflexion séparée, journal des tours (Réglages › Général). »), this plan (bilan section).
- Fix only what a run proves wrong, in the owning task's spirit, and say so in the bilan.

**Steps:**
- [ ] **Pre-flight, before any window run.**
  - Re-run the full suite alone. Expect **1003/1003**. This is also the first full run that contains the reword-fixed test since its fix had never been run, unless Task 1's pre-flight already confirmed 948.
  - Run both `tsc` (core 5, renderer 0) and `npm run renderer:build`.
  - Run `node --experimental-strip-types --test tests/updater.test.mts` first: its guard inspects every launcher of the exe (lesson 2026-10-04).
  - Re-read every `waitFor` and assertion added in Tasks 5–8 against the code they target, asking what each returns on the initial state. Fix a test before its single run, never after.
- [ ] **Window tests, each ONCE.** Run from `electron/`, each as `npm run <script> > ../.superpowers/runs/<script>.log 2>&1; echo exit $?`, then read the log and look at every capture. On failure, report the log and the capture; never re-run.
  - `test:stop`: `stop-visual.cjs` (T5);
  - `test:localmodel`: `local-model-visual.cjs` (T5, T6);
  - `test:chat`: `chat-visual.cjs` (T6, T8);
  - `test:settings-tabs`: `settings-tabs-visual.cjs` (T7);
  - `test:hardware`: `hardware-visual.cjs` (T8);
  - `test:restorefolder`: `restore-folder-visual.cjs`. Not edited, but it asserts the EmptyState text that T8 made conditional.

  That is 6 runs. `final-e2e-tray.cjs` asserts the same text but is not run: it needs the tray flow, and `restore-folder-visual` already proves the no-folder text.
- [ ] **Packaged app, ONCE each** (ask the user first: it is a long run while he may be playing).
  - `npm run package:win > ../.superpowers/runs/package-win.log 2>&1; echo exit $?` must exit 0. `app.asar` must contain `core/turn-log.mts`, `core/reasoning-split.mts`, `core/turn-clock.mts`, `core/abortable.mts` and `core/data-folders.mts`, and no `tests/`.
  - `npm run test:package > ../.superpowers/runs/test-package.log 2>&1; echo exit $?`. This covers the T7 edit: `LISEZMOI.txt` and the folders exist in the packaged app's isolated home.
  - Then `tasklist | grep -i -E "openagent|electron"` must show nothing left.
- [ ] **Manual check with the user (spec « si possible »), controller-run, once.**
  - Launch `release/win-unpacked/openagent.exe` with `OPENAGENT_HOME=<mkdtemp>`, `OPENAGENT_USERDATA_DIR=<mkdtemp>`, `--user-data-dir=<same>` and `OPENAGENT_DISABLE_UPDATES=1`.
  - Give the user an empty temporary work folder to open, and only that one (lesson 2026-10-21).
  - The user imports his Qwen3 model (the library records the path only) and sends one short message.
  - Record in the bilan:
    - the phases seen, and the « Réflexion » block (separated or not);
    - the `[chat] wrapper …` line from the worker output;
    - the timing line;
    - one stop during writing, with the `stopLatencyMs` read from `logs/turns/<day>.jsonl`;
    - a check that the day file holds no `hf_` value.
  - Mark every figure « mesuré » (read from the log or a stopwatch) or « affiché » (shown by the app). Delete both temp folders.
  - If the user is absent, write « non vérifié manuellement » and move on.
- [ ] **Static closure checks.**
  - `git grep -n "oa-typing-dots" -- electron/renderer-src/src` shows the CSS only, or nothing: no component renders it any more.
  - `git diff 9d6ebb8..HEAD -- electron/core/settings.mts` adds `turn_log` and removes no key.
  - `git diff --stat 9d6ebb8..HEAD -- electron/core/web-tools.mts electron/core/search-tools.mts electron/core/workspace.mts` prints nothing: no tool removed.
  - `git grep -n "onTextChunk" -- electron/core` prints nothing: generation reads `onResponseChunk` only.
- [ ] **Bilan in `tasks/todo.md`**, « Bilan du lot — diagnostic des tours (2026-10-21) »:
  - per spec objective 1–9: the proof (test names, the single window outcomes, the manual check) and the commit;
  - the decisions:
    - `readMs` optional;
    - phases from agent events;
    - the splitter rules;
    - deletion for log retention;
    - the log suspended after a migration;
    - « l’instant » with a typographic apostrophe;
    - `comment` segments treated as reasoning;
  - the known limit: no prefill interruption (objective 4), with the measured latencies;
  - what is not proven: no machine without NVIDIA, unless the hardware run was on one; Qwen3 only if the manual check happened.
- [ ] **Lessons.** Add `tasks/lessons.md` lines only for what went wrong in this lot (`date | what | cause | rule`). At the end, propose grouped, verified notes for `D:\BDC` to the user (user memory: BDC at each lot's end). Candidates, if confirmed:
  - node-llama-cpp 3.21.1 cannot abort the prefill;
  - `loadSignal` and `createSignal` throw `signal.reason`;
  - `onTextChunk` excludes thought segments;
  - a template that pre-fills `<think>` leaves a bare `</think>` (only if the manual check confirms it);
  - electron-updater's « no release » error codes.
- [ ] **Commit:**
  ```
  git add README.md tasks/todo.md tasks/lessons.md docs/superpowers/plans/2026-10-21-turn-diagnostics.md <any window test fixed in pre-flight>
  git commit -m "docs: turn diagnostics delivered — bilan, window proofs, packaged proof, lessons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Obj. 1: `phase` events (preparing, loading %, reading, thinking, writing, tool + name, stopping); status line with the seven labels and a timer from the send | T3 (worker-turn-phases 1, 2, 5), T5 (phaseLabel, reducer, TurnStatus, stop-visual, local-model-visual) |
| Obj. 2: `timing` on done and stopped (loadMs, readMs, firstTextMs, totalMs, outputTokens, tokensPerSecond); saved on the reply; one line per reply, load only when it happened | T3 (turn-clock 1–2, worker-turn-phases 1–2), T6 (timingLine, reducer, local-model-visual, chat-visual) |
| Obj. 3: thoughts via `onResponseChunk`, `thinking` events; the `</think>` fallback; `reasoning` saved and never resent; collapsible block open while thinking, folded with its duration; wrapper name and segments logged at load | T2 (reasoning-split 1–6, local-engine c, request-context, agent), T3 (partial reasoning), T6 (block, chat-visual) |
| Obj. 4: stop honoured by `loadSignal`, `createSignal`, `windowFor`/`idle()` and the load lock; « Arrêt en cours… » and a disabled button; prefill limit documented; latency measured and logged | T2 (local-engine a, b), T3 (worker-turn-phases 2–4, limit stated), T4 (`stopLatencyMs`), T5 (stop-requested, stop-visual) |
| Obj. 5: JSONL per day, one line per event (start, phases, prompt tokens, tools, reasoning, reply, stats, stop, errors); `turn_log` full/metadata/off, default full; truncation 20 000; redaction of hf_token, MCP env/headers, sensitive files, token patterns; 14 days at worker start; settings select + open button | T4 (turn-log 1–9, worker-turn-log 1–4), T7 (select, button, main op) |
| Obj. 6: `knowledge/`, `tools/`, `logs/` created; `LISEZMOI.txt` regenerated, every entry and the per-project folder described; nothing existing modified | T7 (data-folders 1–4, package-smoke) |
| Obj. 7: `overflow-wrap: anywhere`; the empty chat with a folder invites a message | T8 (ui-fixes, chat-visual), T9 (restore-folder-visual) |
| Obj. 8: 404/406 → « Aucune version publiée pour l'instant », no « Échec », no stack in the log | T8 (updater tests) |
| Obj. 9: the exact CUDA text when Vulkan runs on NVIDIA | T8 (hardware-view, hardware-visual) |
| Constraints: real tests, isolated home, window tests once, suite alone, no personal path, French, secrets test | Global Constraints; T4 (worker-turn-log 1); T7 (README_TEXT); T9 |
| Vérification attendue: suite + tsc ×2 + build; worker phases, timing, stop during loading, log without tokens; unit splitter, redaction, retention, LISEZMOI, updater; window tests once; manual Qwen3 | each task's run step; T3, T4; T2, T4, T7, T8; T9 |

**Step scan:** every step names files, values and commands. There are no « TBD » and no « handle edge cases ». Algorithms are written out only where tests cannot pin them: the splitter rules (T2), the phase rules (T3) and the log pipeline order (T4). The `LISEZMOI.txt` roles are a decision table; the sentences are left to the implementer, and the test pins each name.

**Type consistency:**
- `TurnTiming` is defined once in `core/model-types.mts` (T2). `turn-clock.mts` re-exports it (T3), `turn-log.mts` consumes it (T4), and `ipc/types.ts` mirrors it with the same fields (T5).
- `LoadEvent`, `GenerationStats` and `WindowOptions` (T2) are consumed by `worker.mjs` (T3).
- `ChatWrapperInfo` (T2) is consumed by the `model-ready` line (T4).
- `TurnLogLevel` and `TURN_LOG_LEVELS` (T4) are consumed by `general-view.ts` (T7).
- The event kinds `phase` and `thinking`, and `timing` on `done` / `stopped`, are produced in T3 and mirrored in T5 (`phase`, `timing`) and T6 (`thinking`).
- Phase names are the same seven strings in T3, T4, T5 and the spec.
- `recordAgentEvents`, `phasesOf` and `callWorker` (T1) are used by the worker tests of T3, T4 and T7.
- **Counts, from the tests each task adds; no task removes a test:**
  - 948 → 950 (T1 +2);
  - → 963 (T2 +13: reasoning-split 6, local-engine 5, request-context 1, agent 1);
  - → 970 (T3 +7: turn-clock 2, worker-turn-phases 5);
  - → 983 (T4 +13: turn-log 9, worker-turn-log 4);
  - → 987 (T5 +4);
  - → 991 (T6 +4);
  - → 998 (T7 +7: data-folders 5, main-routing 2);
  - → 1003 (T8 +5: ui-fixes 2, updater 2, hardware-view 1).
- New files imported in `all.mts`: `worker-events` (T1), `reasoning-split` (T2), `turn-clock`, `worker-turn-phases` (T3), `turn-log`, `worker-turn-log` (T4), `turn-status` (T5), `data-folders` (T7), `ui-fixes` (T8). T6 adds to `turn-status` and needs no import.

**Review Focus coverage:**
1. → T2: reasoning-split 3 and 4, request-context « never sent »; T9 manual Qwen3.
2. → T2: reasoning-split 5.
3. → T2: local-engine a and b; T3: worker-turn-phases 2, 3 and 4; T5: stop-visual; the existing permission and tool stop tests.
4. → T4: turn-log 3, 4, 5 and 8, worker-turn-log 1.
5. → T4: turn-log 7, worker-turn-log 4; T7: data-folders 4.

**Proportion:** the plan holds signatures, pinned values, test names and assertions. The bodies left out are the ones the signatures and tests determine.
