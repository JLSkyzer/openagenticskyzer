# Hardware and Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** The app shows the machine it runs on (engine, card, VRAM, RAM, CPU) in a « Matériel » settings tab. It loads every local `.gguf` with an explicit GPU/CPU layer split that leaves room for a capped context (new setting « Contexte des modèles locaux », default 32 768). It shows the split and the memory of the active model, as an estimate before the load (« estimé ») and as the loaded truth after. On an NVIDIA card it can download an optional CUDA pack, published with each release; when the pack is absent, broken or stale, the app keeps today's Vulkan → CPU behaviour.

**Architecture:**
- **One Llama per worker.** `core/llama-runtime.mts` owns the only `Llama` instance (`getLlama({ build: 'never', … })`, created lazily, shared). The engine, the hardware reading and the estimator all use it, so the three always talk about the same backend.
- **Hardware.** `core/hardware.mts::readHardware()` reads the runtime Llama (`gpu`, `getGpuDeviceNames()`, `getVramState()`, `cpuMathCores`) and Node `os` (`totalmem`, `freemem`, `cpus`). Worker op `hardware-info`.
- **Context rule.** `core/context-budget.mts::localContextSize()` turns the `local_context` setting, the model's train context and `max_tokens` into the one context size the engine loads with, the estimator plans with, and `model-status` reports before a load.
- **Deterministic load.** `core/local-engine.mts` loads with `gpuLayers: { fitContext: { contextSize } }` and creates the context with that exact `contextSize`. The loaded engine is keyed on (path, context size, runtime generation): a changed setting reloads at the next message. After the load, `model.gpuLayers` is the reported truth. An `InsufficientMemoryError` becomes one French message, and nothing stays half-loaded.
- **Shared placement type.** `core/placement.mts` (pure, imported by the renderer as `core/context-budget.mts` already is) defines `Placement`, `Fit`, `Backend` and `fitOf`. Memory is always `memoryMeasured: false`: node-llama-cpp 3.21.1 documents `LlamaModel.memoryUsage` and `LlamaContext.memoryUsage` as « Assumed memory footprint » (`dist/evaluator/LlamaModel/LlamaModel.d.ts:224`, `LlamaContext.d.ts:51`), a reservation and not a measurement, so the page always says « estimé » for bytes.
- **Estimate.** `core/offload-estimate.mts::estimatePlacement()` runs, without loading weights, the same resolver `loadModel` runs (`configurationResolver.resolveModelGpuLayersV2`, called at `LlamaModel.js:523`) with the same options. It is persisted in `<dataHome>/estimates.v1.json`, keyed on file + hardware + context. `core/estimate-jobs.mts` runs one estimate at a time, in the background, cancellable. The worker answers `estimate-model` at once and posts an `estimate` event when done. A turn cancels a running estimate, and an estimate is refused while a turn runs.
- **Model status.** `ModelStatus` gains an optional `placement`: the loaded one, else the cached estimate. It travels on the existing `model` event and `model-status` op.
- **CUDA pack (gated by Task 1).** `core/cuda-pack-format.mts` is a deterministic, gzip, record-stream archive split into parts under 2 GiB. `scripts/cuda-pack.mts` builds it from `@node-llama-cpp/win-x64-cuda`, `win-x64-cuda-ext` and the NVIDIA runtime DLLs. Its manifest (part hashes, engine version) is committed in `electron/resources/cuda-pack/manifest.json` and packaged through `extraResources`. `core/cuda-pack.mts` downloads the parts of the app's own GitHub release, verifies them, checks free space, extracts into `<dataHome>/cuda-pack/current/` through a staging folder, and handles cancel, uninstall and engine-version mismatch. The runtime activates an installed, matching pack with the mechanism Task 1 chooses, and tries `gpu: 'cuda'` first. On any failure it falls back to the non-CUDA backends with a French notice.

**Tech Stack:**
- Electron 44.4.2, Node 24.21.0 (`--experimental-strip-types`, `worker_threads`, `node:test`, `module.registerHooks` available: checked on 2026-10-18 with `node -e` and `ELECTRON_RUN_AS_NODE=1 electron -e`).
- node-llama-cpp 3.21.1 (`getLlama`, `readGgufFileInfo`, `GgufInsights`, `InsufficientMemoryError`, `getModuleVersion`).
- React 19, Vite 8, TypeScript 7, electron-builder 26, `gh` CLI for the release upload.
- No new dependency. gzip comes from `node:zlib`; hashes from `node:crypto`; free space from `fs.statfs`.

**Spec:** `docs/superpowers/specs/2026-10-18-hardware-and-offload-design.md` (binding, validated by the user, including « Décisions après relecture »).

## Global Constraints

- Tests are real, without mocks, red first (« Tests réels sans mocks, test rouge d'abord. `stories260K.gguf` sert de modèle réel. »).
- The user's real data is never touched: every worker and window test gets `OPENAGENT_HOME=<mkdtemp>`; `%USERPROFILE%\.openagent` is never read or written (« Les tests ne touchent jamais les données réelles : `OPENAGENT_HOME` est isolé. »).
- Every window test runs ONCE, with all its output written to a file: `> ../.superpowers/runs/<name>.log 2>&1; echo exit $?`, then filter the file. A failure is reported, never re-run (« Tout test à fenêtre est lancé **une seule fois**, sortie complète dans un fichier. »). All window runs happen in Task 13.
- No test downloads the real CUDA pack (« Aucun test ne télécharge le pack CUDA réel. Le téléchargement est testé contre un faux serveur local »). The real CUDA load is a manual or packaged check, said as such.
- Public repository: no personal path or data (« Dépôt public : aucun chemin ni aucune donnée personnelle. »). The user's 27B is named « le 27B IQ3_M de l'utilisateur » in every written trace, never by its path.
- Performance and memory figures are called measured only if they were (« Les chiffres de performance ne sont présentés comme mesurés que s'ils l'ont été. »).
- No tool and no setting is removed (« On ne retire AUCUN outil »). `max_tokens` keeps its rule `null | 2048..2097152`.
- `MIN_LOCAL_CONTEXT` = **16 384** (« `MIN_LOCAL_CONTEXT` vaut 16 384 »).
- `LOCAL_OUTPUT_CAP` stays **8192**.
- « Contexte des modèles locaux » values: « 16k, 32k, 64k, 128k ou « max du modèle » », i.e. `16384 | 32768 | 65536 | 131072 | 'max'`.
- Its default is « **32 768**, plafonné par ce que le modèle supporte ».
- « Changer la valeur recharge le modèle au message suivant. »
- « Le réglage `max_tokens` existant reste un plafond de la fenêtre de requête, comme aujourd'hui. »
- Load call: `gpuLayers: { fitContext: { contextSize } }` (« On charge avec `gpuLayers: { fitContext }` »).
- Pre-load numbers are marked « estimé »; after the load, `model.gpuLayers` is the truth.
- Memory: « jamais une différence globale avant / après présentée comme une mesure ».
- Estimate cache key: « le fichier (taille et date de modification ou empreinte), le matériel et le contexte ».
- Estimate: « Le calcul se fait en arrière-plan, sans bloquer l'interface, et peut être annulé. »
- Estimate source: « Lecture distante préparée » for project 2, not implemented here.
- CUDA pack: « morceaux de moins de 2 Gio, empreinte intégrée à l'app »; « taille affichée avant le téléchargement, une vérification d'intégrité, la vérification de l'espace disque et une annulation possible »; it lives « dans le dossier de données de l'app ».
- Stale pack after an update: « l'app repasse en Vulkan et propose de télécharger le bon pack ».
- Releases: « Toute exécution du script de release se fait en `--dry-run` »; « Une publication réelle n'a lieu qu'avec l'accord explicite de l'utilisateur ». `release-win.cjs` is never run without `--dry-run` in this lot.
- The GitHub token is never printed or written (the dry-run prints its length only, as today).
- Final measurement: « Le fichier est ajouté à la bibliothèque d'une app de test isolée : on ne touche ni sa vraie bibliothèque, ni le fichier. »
- Every `getLlama` call passes `build: 'never'`: a missing or broken prebuilt binary must never start a llama.cpp download or compilation.
- **Verification baselines**, all commands from `electron/`:
  - suite `node --experimental-strip-types --test tests/all.mts`: **853/853 at ea3e07e**. Run it ALONE, never beside `tsc`, a build or another suite (lesson 2026-10-18);
  - `npx tsc --noEmit -p tsconfig.core.json`: **5 pre-existing errors only**;
  - `npx tsc --noEmit -p renderer-src/tsconfig.json`: **0**;
  - `npm run renderer:build`: exit 0.
- **Test count.** Each task gives the suite count after it. A different `# tests` line is explained in the bilan before moving on, and the explanation is checked against the files (lesson 2026-10-17).
- **Commits.**
  - Each task stages only its own paths with an explicit `git add <paths>` from the repository root. Never `git add -A` or `git add .`.
  - Never stage the user's unrelated changes:
    - `docs/superpowers/plans/2026-04-27-onboarding-auto.md` and `2026-04-27-semantic-plugins.md` (deleted in the work tree);
    - `docs/superpowers/plans/liste logique à suivre.txt`;
    - `docs/superpowers/plans/OK 2026-04-27-*.md`;
    - `docs/superpowers/plans/2026-09-14-native-desktop-gui.md`, `2026-10-01-mcp-enhancement.md`;
    - `docs/superpowers/specs/2026-09-14-*`.
  - This plan file is staged only in Task 1 (with the spike bilan) and in Task 13.
  - Every message ends with the trailer paragraph `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a last `-m`.
  - Push after each commit: `git push origin master` (user's standing instruction).
- **Packaging.** No new `.cjs` beside `main.cjs`. New core modules ship through `build.files` → `core/**/*`. `tests/**` and `scripts/**` stay out of `build.files`.
- **Downloads by the agent.** Any download outside the tests (NVIDIA redistributables in Task 1 and Task 12) is announced to the user with file names, source URL and size, and waits for an explicit yes.

## Review Focus

1. **A model bigger than the card** (the user's 27B case: 7,77 Gio of VRAM). The split shown must be the split loaded. On `stories260K.gguf`, the estimate gives the same `gpuLayers`, `totalLayers` and `backend` as the real load in the same process. After a load, the placement shown is `model.gpuLayers`, never the estimate. Pinned by Task 5 test 1 (`offload-estimate.test.mts`), Task 4 test 1 (`local-engine.test.mts`) and Task 6 test l (`worker-model.test.mts`). The 27B itself is checked by the manual measurement in Task 13.
2. **Even 0 layers on the card does not fit.** Loading fails with the exact `localModelTooBig(contextSize)` text. `warmModelPath()` is `null` afterwards, and the next normal load works. Pinned by Task 4 test 2.
3. **Context ballooning.** The context never follows free memory any more:
   - default 32 768 on a model trained for 131 072;
   - « max du modèle » gives the train size;
   - `max_tokens` caps the engine;
   - a small model keeps the 16 384 floor;
   - changing the setting reloads at the next message.

   Pinned by Task 3 test 1 (rule table) and Task 4 tests h, i, k (`worker-model.test.mts`, real engine on a GGUF whose train context is patched to 131 072).
4. **CUDA pack absent, corrupt or stale after an app update.** The app keeps an engine: the backend falls back to Vulkan or CPU, with the exact French notice, and a real turn still answers. A stale pack is never loaded. Pinned by Task 10 tests 1 and 2 (`worker-cuda-pack.test.mts`).
5. **Hostile or broken download.** Each of these leaves nothing installed and no staging folder: a tampered part (`CUDA_PACK_CORRUPT`), a path outside the allowed prefixes (`cudaPackUnsafePath`), not enough disk (`cudaPackDiskNotice`), a cancel mid-download (`AbortError`), a non-https redirect. Pinned by Task 8 test 4 and Task 9 tests 3, 4, 5 and 8.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `electron/core/llama-runtime.mts` | **create** (T2), grows (T10) | the one `Llama` of the worker; `build: 'never'`; CUDA pack activation and fallback notice (T10) |
| `electron/core/hardware.mts` | **create** (T2) | `readHardware()` → `HardwareInfo` |
| `electron/core/placement.mts` | **create** (T2) | pure: `Backend`, `Fit`, `Placement`, `fitOf` |
| `electron/core/units.mts` | **create** (T2) | pure: `formatBytes` (Gio / Mio, French decimal comma) |
| `electron/core/context-budget.mts` | modify (T3) | `LOCAL_CONTEXT_CHOICES`, `DEFAULT_LOCAL_CONTEXT`, `localContextSize` |
| `electron/core/settings.mts` | modify (T3) | `local_context` default and rule |
| `electron/core/local-engine.mts` | modify (T4) | runtime Llama, `fitContext`, exact context, reload key, `loadedPlacement`, `plannedContextSize`, `localModelTooBig` |
| `electron/core/active-model.mts` | modify (T4, T6) | planned pre-load window (T4); `placement` (T6) |
| `electron/core/offload-estimate.mts` | **create** (T5) | `estimatePlacement`, `ModelSource`, `EstimateCache`, `estimateKey` |
| `electron/core/estimate-jobs.mts` | **create** (T5) | one background estimate at a time, dedupe, cancel |
| `electron/core/cuda-pack-format.mts` | **create** (T8) | archive write/extract, chunking, manifest, safe paths |
| `electron/core/cuda-pack.mts` | **create** (T9) | status, download, verify, disk check, cancel, uninstall, mismatch |
| `electron/scripts/cuda-pack.mts` | **create** (T8) | builds the pack from `node_modules` + a runtime folder |
| `electron/resources/cuda-pack/manifest.json` | **create** (T12) | the committed manifest: « empreinte intégrée à l'app » |
| `electron/worker.mjs` | modify (T2, T4–T6, T10) | ops `hardware-info`, `estimate-model`, `estimate-cancel`, `cuda-pack-*`; events `estimate`, `cuda-pack` |
| `electron/main.cjs` | modify (T2, T5, T10) | `allowed` ops; `workerOptions` gains `cudaPackManifest` (T10) |
| `electron/preload.cjs` | modify (T6, T10) | `onEstimateEvent`, `onCudaPackEvent` |
| `electron/package.json` | modify (T7, T12) | `test:hardware` (T7); `cuda-pack:build`, `extraResources` (T12) |
| `electron/scripts/release-win.cjs` | modify (T12) | builds and verifies the pack; dry-run summary; upload after the draft |
| renderer `ipc/types.ts`, `ipc/bridge.ts` | modify (T6, T10) | mirrors and calls |
| renderer `components/model/placement.ts` | **create** (T6) | `placementLabel`, `memoryLabel` |
| renderer `components/model/ModelButton.tsx`, `ModelDialog.tsx` | modify (T7) | placement chip; estimate request and cancel |
| renderer `components/settings/HardwareTab.tsx`, `hardware-view.ts` | **create** (T7), grow (T11) | « 🖥️ Matériel » tab; pure view helpers |
| renderer `components/settings/SettingsDialog.tsx` | modify (T7) | 8th tab |
| `electron/tests/support/gguf-fixture.mts` | **create** (T3) | `withTrainContext()`: a real GGUF with a patched train context |
| `electron/tests/support/fake-pack-server.mts` | **create** (T9) | 127.0.0.1 server for pack parts: throttle, redirect, tamper |
| `electron/tests/support/fake-cuda-pack.mts` | **create** (T10) | writes an installed pack (corrupt or mismatched) into a temp home |
| tests `hardware`, `local-context`, `offload-estimate`, `worker-estimate`, `placement-format`, `hardware-view`, `cuda-pack-format`, `cuda-pack-install`, `worker-cuda-pack` (`.test.mts`) | **create** | per task |
| tests `local-engine`, `worker-model`, `main-routing`, `test-seam`, `bridge-connection`, `release-win` (`.test.mts`), `all.mts` | modify | per task |
| `electron/tests/hardware-visual.cjs`, `run-hardware-visual.cjs` | **create** (T7), grow (T11) | window proof of the Matériel tab |
| `electron/tests/settings-visual.cjs`, `local-model-visual.cjs`, `preload-bridge.cjs`, `package-smoke.cjs` | modify (T7, T6, T12) | window proofs, run in T13 |
| `electron/tests/cuda-real.cjs` | **create** (T12) | manual real CUDA load, outside the suite |
| `README.md`, `tasks/todo.md`, `tasks/lessons.md` | modify (T13) | closure |

---

## Task 1: CUDA spike — redistribution and loading outside `node_modules`

This is the first CUDA task, placed first so the user hears the answer before any CUDA code exists. Tasks 2–7 do not depend on it. **Tasks 8–12 run only if its decision is GO.**

**Files:**
- Modify: this plan, section « Bilan — Task 1 (spike CUDA) » at the end.
- Scratch only: everything the spike downloads or writes goes to a fresh `mkdtemp` folder outside the repository, never into `electron/node_modules`.

**Already observed while writing this plan (2026-10-18, to re-check):**
- Both packages hold only `LICENSE` (MIT, « Copyright (c) 2024 Gilad S. »), `README.md`, `package.json`, `dist/index.js` and `bins/`. There is no NVIDIA licence and no NVIDIA runtime DLL.
- `win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll` (144 822 784 bytes) names `cublas64_13.dll` and `nvcuda.dll` and no `cudart64_*`. It is a CUDA 13 build; cudart is presumably static (to confirm from its import table).
- `win-x64-cuda-ext/bins/win-x64-cuda/fallback/ggml-cuda.dll` (367 827 968 bytes) names `cudart64_12.dll`, `cublas64_12.dll` and `nvcuda.dll`: a CUDA 12 fallback. **So `-ext` does not bring the CUDA runtime.** It brings a second build that needs CUDA 12 DLLs.
- node-llama-cpp looks for prebuilt binaries in two places (`dist/bindings/utils/compileLLamaCpp.js:299-331, 402-470`):
  1. `node-llama-cpp/bins/<folder>`;
  2. `import("@node-llama-cpp/win-x64-cuda")` / `import("@node-llama-cpp/win-x64-cuda-ext")`. Their `getBinsDir()` must report the same version as node-llama-cpp, or the package is ignored.
- Runtime detection reads `CUDA_PATH` and `<CUDA_PATH>/bin` for `cudart64_1x.dll`, `cublas64_1x.dll` and `cublasLt64_1x.dll` (`detectAvailableComputeLayers.js:22-56`).
- Every binary folder (`win-x64`, `win-x64-vulkan`, `win-x64-cuda`) ships DLLs with the same names: `ggml-base.dll`, `llama-common.dll`, `ggml-cpu-*.dll`. Two backends in one process may therefore collide.

**Interfaces:** none (no production code).

**Steps:**
- [ ] **S1 — Inventory.** Record in the bilan:
  - each package's file list and sizes;
  - each `ggml-cuda.dll`'s imported DLLs, read from the PE import table (a 30-line Node PE reader in the scratch folder, or `objdump -p` if Git ships it) rather than by `grep -a`;
  - `nvidia-smi` « CUDA Version » and driver version on the user's machine;
  - for each DLL the pack must carry: name, source and size.
- [ ] **S2 — Licence.** Read the current NVIDIA CUDA Toolkit EULA from `docs.nvidia.com/cuda/eula` (Attachment A, the redistributable list) and the `LICENSE.txt` at the root of each NVIDIA redistrib archive the pack would use (`developer.download.nvidia.com/compute/cuda/redist/`, components `cuda_cudart` and `libcublas`). Record in the bilan:
  - the EULA date and version;
  - whether each needed DLL (`cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `cublas64_13.dll`, `cublasLt64_13.dll`, and any other the import tables show) is on the redistributable list;
  - the conditions attached, in a paraphrase and at most one quote under 15 words.

  The node-llama-cpp packages themselves are MIT: cite their `LICENSE` file path.
- [ ] **S3 — Fetch the runtime.** Announce to the user the exact archives (name, URL, size from NVIDIA's `redistrib_<version>.json`) and wait for a yes. Then download them into the scratch folder, verify each one's sha256 against that JSON, and unpack only the DLLs. Never into the repository.
- [ ] **S4 — Load from outside `node_modules`.** Use an Electron script in the scratch folder: Electron main → a `worker_threads` Worker, exactly as `main.cjs` runs `worker.mjs`, with `OPENAGENT_HOME` = a temp folder. Copy the two packages and the runtime DLLs into `<scratch>/pack/`. Try, in this order, and record each outcome:
  - **A.** In the worker, `module.registerHooks({ resolve })` maps the bare specifiers `@node-llama-cpp/win-x64-cuda` and `@node-llama-cpp/win-x64-cuda-ext` to `<scratch>/pack/node_modules/@node-llama-cpp/<name>/dist/index.js`. The runtime DLLs sit beside each `ggml-cuda.dll` (CUDA 13 beside the main one, CUDA 12 in `fallback/`). Then `getLlama({ gpu: 'cuda', build: 'never' })`.
  - **B.** As A, but the runtime DLLs stay in `<scratch>/pack/cuda-runtime/`, and the Electron main process prepends that folder to `process.env.PATH` before creating the Worker. A worker's `process.env` is a copy and does not change the OS search path.
  - **C.** As B, with `CUDA_PATH` set instead of `PATH`.

  Success means `llama.gpu === 'cuda'`, then `loadModel({ modelPath: stories260K, gpuLayers: { fitContext: { contextSize: 16384 } } })` with `model.gpuLayers > 0`, and a 4-token generation. Also record which build loaded (main or `fallback/`) and the child-process binary test's stderr.
- [ ] **S5 — Switching backend in one process.** In the same Electron process:
  1. create a Vulkan Llama (`getLlama({ build: 'never' })`), load stories260K, dispose everything;
  2. then run the successful mechanism of S4.

  Record whether CUDA loads, fails cleanly, or crashes the process. Then the reverse: CUDA first, then Vulkan.
- [ ] **S6 — Sizes.** Build nothing yet. Sum the raw bytes of everything the pack would hold. Gzip each file once (`zlib.gzipSync`, level 9) to estimate the download size, and say it is an estimate.
- [ ] **Decision, written in the bilan as D-CUDA-1…4:**
  - **D-CUDA-1, licence:** GO only if every needed NVIDIA DLL is redistributable inside an application under conditions this project meets. Otherwise **NO-GO: stop Tasks 8–12 and tell the user before implementing anything** (spec: « si elle ne l'autorise pas, on le dit avant d'implémenter »). The alternative to propose: a pack with only the MIT node-llama-cpp binaries, plus a check that the user installed the CUDA Toolkit himself (detected through `CUDA_PATH`).
  - **D-CUDA-2, mechanism:** the first of A, B, C that succeeded. If none did, NO-GO with the same report.
  - **D-CUDA-3, runtime placement:** `beside-binaries` (A) or `cuda-runtime/` (B, C). Task 8's `collectPackFiles` and Task 10's activation follow it.
  - **D-CUDA-4, switch:** if S5 shows a clean in-process switch, a pack change applies at the next load (runtime generation bump). Otherwise it applies at the next app start: `restartRequired`, and the « Redémarrer maintenant » button reuses the existing `restart-app` op. The spec's « utilisation au prochain chargement » then becomes « au prochain démarrage de l'app », and the user is told so in the bilan and in the final reply.
- [ ] **Report to the user** (the controller relays it): D-CUDA-1…4 and the S6 size, in one short paragraph. On NO-GO, wait for his answer before Task 8.
- [ ] **Commit** (suite unchanged: **853**):
  ```
  git add docs/superpowers/plans/2026-10-18-hardware-and-offload.md
  git commit -m "docs: hardware and offload plan, with the CUDA spike's findings (licence, runtime DLLs, loading outside node_modules)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 2: One Llama per worker, and the hardware reading

**Files:**
- Create: `electron/core/llama-runtime.mts`, `electron/core/hardware.mts`, `electron/core/placement.mts`, `electron/core/units.mts`, `electron/tests/hardware.test.mts`.
- Modify: `electron/worker.mjs` (op `hardware-info` in `ops` and `handle`), `electron/main.cjs` (`'hardware-info'` in `allowed`), `electron/tests/main-routing.test.mts` (one assertion added to « main folds nothing into a payload »), `electron/tests/all.mts`.

**Interfaces:**
- Produces `core/placement.mts` (pure, no import):
  ```ts
  export type Backend = 'cuda' | 'vulkan' | 'metal' | 'cpu';
  export type Fit = 'gpu' | 'split' | 'cpu' | 'none';
  export interface Placement {
    source: 'estimate' | 'loaded'; backend: Backend; gpuLayers: number; totalLayers: number;
    contextSize: number; vramBytes: number; ramBytes: number; memoryMeasured: false; fit: Fit;
  }
  export function fitOf(input: { backend: Backend; gpuLayers: number; totalLayers: number; ramBytes: number; ramTotal: number; insufficient: boolean }): Fit;
  // insufficient || ramBytes > ramTotal → 'none'; backend 'cpu' or gpuLayers 0 → 'cpu'; gpuLayers >= totalLayers → 'gpu'; else 'split'
  ```
- Produces `core/units.mts` (pure): `export function formatBytes(bytes: number): string`. At least 2^30 → `x,x Gio` (one decimal, comma); otherwise `n Mio` (rounded, minimum 1 for any positive size; `0 Mio` for 0).
- Produces `core/llama-runtime.mts`:
  ```ts
  export async function runtimeLlama(): Promise<Llama>;   // getLlama({ build: 'never' }) once; a rejected creation is not cached
  export function llamaCreated(): boolean;
  export async function disposeLlama(): Promise<void>;
  export function backendOf(llama: Llama): Backend;       // llama.gpu === false ? 'cpu' : llama.gpu
  ```
  No `gpu` option is passed in this task. node-llama-cpp then reads `NODE_LLAMA_CPP_GPU` at import (`dist/config.js:54`), which the tests use for the no-card variant.
- Produces `core/hardware.mts`:
  ```ts
  export interface HardwareInfo {
    backend: Backend; gpuNames: string[]; vram: { total: number; free: number } | null;
    ram: { total: number; free: number }; cpu: { model: string; mathCores: number; logicalCores: number };
    nvidia: boolean; notice: string | null;
  }
  export async function readHardware(): Promise<HardwareInfo>;
  // vram null and gpuNames [] when backend is 'cpu'; ram from os.totalmem()/os.freemem(); cpu.model os.cpus()[0].model,
  // mathCores llama.cpuMathCores, logicalCores os.availableParallelism(); nvidia = gpuNames.some(/nvidia/i); notice null (T10 fills it)
  ```
- Worker op `hardware-info` (payload `{ refresh?: boolean }`, ignored for now: every call re-reads free memory) → `HardwareInfo`.

**Steps:**
- [ ] **Write the failing tests** in `tests/hardware.test.mts`:
  ```ts
  test('readHardware: backend, RAM from os, CPU cores, GPU fields consistent with the backend', { timeout: 60000 }, …)
    // backend ∈ ['cuda','vulkan','metal','cpu']; ram.total === os.totalmem(); 0 < ram.free <= ram.total;
    // cpu.mathCores >= 1; cpu.logicalCores === os.availableParallelism(); cpu.model === os.cpus()[0].model;
    // backend === 'cpu' ? (vram === null && gpuNames.length === 0) : (vram.total > 0 && vram.free <= vram.total && gpuNames.length >= 1)
  test('the runtime Llama is created once and shared, and disposeLlama frees it', { timeout: 60000 }, …)
    // assert.equal(await runtimeLlama(), await runtimeLlama()); assert.equal(llamaCreated(), true);
    // await disposeLlama(); assert.equal(llamaCreated(), false)
  test('worker hardware-info: with NODE_LLAMA_CPP_GPU=false the backend is cpu, with no VRAM and no card', { timeout: 60000 }, …)
    // worker env { ...process.env, OPENAGENT_HOME: tmp, NODE_LLAMA_CPP_GPU: 'false' }
    // assert.equal(info.backend, 'cpu'); assert.equal(info.vram, null); assert.deepEqual(info.gpuNames, []); assert.equal(info.nvidia, false)
  test('fitOf and formatBytes', () => { … })
    // fitOf: 'none' (insufficient), 'none' (ramBytes > ramTotal), 'cpu' (backend cpu), 'cpu' (gpuLayers 0), 'gpu' (6/6), 'split' (31/63)
    // formatBytes(8_342_000_000) === '7,8 Gio'; formatBytes(1_048_576 * 300) === '300 Mio'; formatBytes(1) === '1 Mio'; formatBytes(0) === '0 Mio'
  ```
  In `main-routing.test.mts`, add `assert.equal(main.isBackendOp('hardware-info'), true);` to « main folds nothing into a payload: no connection resolution is left ».
- [ ] **Run:** `node --experimental-strip-types --test tests/hardware.test.mts tests/main-routing.test.mts`.
  - Expect FAIL: `Cannot find module '../core/hardware.mts'`, and `isBackendOp('hardware-info')` false.
- [ ] **Implement** per Interfaces. Add the op to `worker.mjs` `ops` and `handle`, and to `main.cjs` `allowed`.
- [ ] **Run:** the two files, then the full suite alone. Expect PASS: **857/857** (853 + 4). Then both `tsc` (core 5, renderer 0) and `npm run renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/llama-runtime.mts electron/core/hardware.mts electron/core/placement.mts electron/core/units.mts electron/worker.mjs electron/main.cjs electron/tests/hardware.test.mts electron/tests/main-routing.test.mts electron/tests/all.mts
  git commit -m "feat: one Llama per worker and a hardware-info op — engine, card, VRAM, RAM and CPU read from node-llama-cpp and os" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 3: The « Contexte des modèles locaux » setting and the capped-context rule

**Files:**
- Create: `electron/tests/support/gguf-fixture.mts`, `electron/tests/local-context.test.mts`.
- Modify: `electron/core/context-budget.mts`, `electron/core/settings.mts`, `electron/tests/all.mts`.

**Interfaces:**
- `core/context-budget.mts` (stays import-free):
  ```ts
  export const LOCAL_CONTEXT_CHOICES = [16384, 32768, 65536, 131072, 'max'] as const;
  export type LocalContextSetting = typeof LOCAL_CONTEXT_CHOICES[number];
  export const DEFAULT_LOCAL_CONTEXT = 32768;
  export function localContextSize(input: { setting: LocalContextSetting; trainContextSize: number | undefined; maxTokens: number | null }): number;
  ```
- **The rule** (left to the builder by the spec; justified here):
  - `requested` is the setting, or for `'max'` the train size; `'max'` with an unknown train size falls back to `DEFAULT_LOCAL_CONTEXT`.
  - result = `max(MIN_LOCAL_CONTEXT, min(requested, trainContextSize ?? requested, maxTokens ?? requested))`.
  - Why:
    - the model's train size caps the choice (« plafonné par ce que le modèle supporte »);
    - `max_tokens` caps it too (objective 3). There is no reason to reserve memory for a context the request window may never use, and `effectiveWindow` keeps capping the request exactly as today;
    - the floor comes last, so a small model keeps today's 16 384 even above its train size (« Une valeur supérieure à l'entraînement reste permise comme aujourd'hui pour un petit modèle »), and a `max_tokens` below 16 384 cannot shrink the engine under the floor;
    - the result is never rounded. Every choice is a multiple of 256, as llama.cpp pads `n_ctx` to 256, and the tests use multiples of 256 for `max_tokens`.
- `core/settings.mts`: `globalDefaults.local_context = 32768`; `globalRules.local_context = choice(16384, 32768, 65536, 131072, 'max')`. `publicGlobal()` returns it, since it iterates `globalDefaults`.
- `tests/support/gguf-fixture.mts`: `export async function withTrainContext(source: string, destination: string, trainContextSize: number): Promise<void>`. It copies the GGUF and overwrites, in place, the uint32 value of the metadata key `<arch>.context_length` (found by parsing the GGUF v3 header: magic, version, tensor count, kv count, then key/type/value records). The file size is unchanged. It throws `GGUF fixture: <arch>.context_length introuvable` if the key is absent.

**Steps:**
- [ ] **Write the failing tests** in `tests/local-context.test.mts`:
  ```ts
  test('localContextSize: the setting, capped by the train size and max_tokens, floored at MIN_LOCAL_CONTEXT', () => {
    const cases = [
      [32768, 2048, null, 16384], [32768, 131072, null, 32768], ['max', 131072, null, 131072], [131072, 32768, null, 32768],
      [65536, 131072, 24576, 24576], [65536, 131072, 8192, 16384], ['max', undefined, null, 32768], [16384, undefined, null, 16384],
    ];
    for (const [setting, train, maxTokens, expected] of cases) assert.equal(localContextSize({ setting, trainContextSize: train, maxTokens }), expected, JSON.stringify([setting, train, maxTokens]));
  });
  test('the five choices and the 32768 default', () => {
    assert.deepEqual([...LOCAL_CONTEXT_CHOICES], [16384, 32768, 65536, 131072, 'max']); assert.equal(DEFAULT_LOCAL_CONTEXT, 32768);
  });
  test('local_context setting: default 32768, the five values accepted, anything else refused with « Paramètre invalide : local_context »', …)
    // SettingsService on a mkdtemp home: (await s.publicGlobal()).local_context === 32768;
    // for each choice: saveGlobal({ local_context: v }) then global().local_context === v;
    // for 4096, '32768', 'MAX', null: rejects { message: 'Paramètre invalide : local_context' }
  test('withTrainContext writes a real GGUF whose train context node-llama-cpp reads back', …)
    // withTrainContext(stories260K, tmp, 131072); (await readGgufFileInfo(tmp)) → GgufInsights.from(info).trainContextSize === 131072;
    // statSync(tmp).size === statSync(stories260K).size
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/local-context.test.mts`.
  - Expect FAIL: `localContextSize is not a function`, and the missing fixture module.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the file, then the full suite alone. Expect PASS: **861/861** (857 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/context-budget.mts electron/core/settings.mts electron/tests/support/gguf-fixture.mts electron/tests/local-context.test.mts electron/tests/all.mts
  git commit -m "feat: « Contexte des modèles locaux » setting (16k–128k or the model's max, 32k by default) and the one capped-context rule" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 4: Deterministic load — fitContext, exact context, clear failure

**Files:**
- Modify:
  - `electron/core/local-engine.mts`;
  - `electron/core/active-model.mts` (pre-load window = planned size);
  - `electron/worker.mjs`: `turnProvider` passes the context request;
  - `electron/tests/local-engine.test.mts`, `electron/tests/worker-model.test.mts`.

**Interfaces:**
- Consumes: `runtimeLlama`, `backendOf` (T2); `fitOf`, `Placement` (T2); `localContextSize`, `LocalContextSetting`, `DEFAULT_LOCAL_CONTEXT` (T3).
- `core/local-engine.mts` produces:
  ```ts
  export interface ContextRequest { setting: LocalContextSetting; maxTokens: number | null }
  export const DEFAULT_CONTEXT_REQUEST: ContextRequest; // { setting: DEFAULT_LOCAL_CONTEXT, maxTokens: null }
  export function localModelTooBig(contextSize: number): string;
  // `Modèle trop gros pour cette machine avec un contexte de ${contextSize} tokens : même sans couche sur la carte graphique, la mémoire ne suffit pas. Baisse « Contexte des modèles locaux » (Réglages › Matériel) ou choisis un modèle plus petit.`
  export async function plannedContextSize(modelPath: string, request: ContextRequest): Promise<number>;
  // readGgufFileInfo + GgufInsights.from(info).trainContextSize, cached per (path, size, mtimeMs); then localContextSize
  export async function loadLocalModel(modelPath: string, contextSize: number): Promise<Placement>;
  // reuses the warm engine iff path, contextSize and runtime generation are equal; else disposeEngine() then
  // llama.loadModel({ modelPath, gpuLayers: { fitContext: { contextSize } } }) and model.createContext({ contextSize });
  // InsufficientMemoryError from either step → dispose what was created, `loaded` stays null, throw new Error(localModelTooBig(contextSize))
  export function loadedPlacement(modelPath: string): Placement | null;
  // { source: 'loaded', backend: backendOf(llama), gpuLayers: model.gpuLayers, totalLayers: model.fileInsights.totalLayers,
  //   contextSize: context.contextSize, vramBytes: model.memoryUsage.vram + context.memoryUsage.vram,
  //   ramBytes: model.memoryUsage.ram + context.memoryUsage.ram, memoryMeasured: false, fit: fitOf({ …, ramTotal: os.totalmem(), insufficient: false }) }
  export function localProvider(modelPath: string, request?: ContextRequest): ModelProvider;   // default DEFAULT_CONTEXT_REQUEST
  export async function engineContextSize(modelPath: string, request?: ContextRequest): Promise<number>;
  export interface LocalCompletionOptions { /* as today */ contextRequest?: ContextRequest }
  ```
  - `disposeEngine()` disposes the context and the model, not the Llama: the runtime owns it.
  - `contextSizeFor` and its stale « Floored at 4096 » comment (`local-engine.mts:28-37`) are removed.
- `core/active-model.mts`: `modelStatus` reports `contextWindow = loadedContextSize(path) ?? await plannedContextSize(path, request)`, with `request` read from the global settings (`local_context`, `max_tokens`). A missing or unreadable file falls back to `MIN_LOCAL_CONTEXT`. The 5 existing fields are unchanged in shape.
- `worker.mjs::turnProvider`: `localProvider(model.path, { setting: global.local_context, maxTokens: global.max_tokens })`.

**Steps:**
- [ ] **Write the failing tests.** In `tests/local-engine.test.mts`, keep the 9 existing tests unchanged (the default request gives stories260K 16 384, as today) and add:
  ```ts
  test('loadLocalModel loads with fitContext: the placement is model.gpuLayers, the total layers and the exact context size', { timeout: 60000 }, …)
    // const p = await loadLocalModel(modelPath, 16384); p.source === 'loaded'; p.contextSize === 16384;
    // p.totalLayers === (await GgufInsights.from(await readGgufFileInfo(modelPath))).totalLayers; 0 <= p.gpuLayers <= p.totalLayers;
    // p.backend === backendOf(await runtimeLlama()); p.memoryMeasured === false; deepEqual(loadedPlacement(modelPath), p)
  test('a context the machine cannot hold fails with localModelTooBig and leaves nothing loaded', { timeout: 120000 }, …)
    // await assert.rejects(loadLocalModel(modelPath, 2 ** 28), { message: localModelTooBig(2 ** 28) });
    // warmModelPath() === null; loadedPlacement(modelPath) === null; then (await loadLocalModel(modelPath, 16384)).contextSize === 16384
  test('the engine reloads when the context size changes, and only then', { timeout: 60000 }, …)
    // patched = withTrainContext(stories, tmp, 131072); a = await loadLocalModel(patched, 32768); b = await loadLocalModel(patched, 32768) → same instance (warm, < 3000 ms);
    // c = await loadLocalModel(patched, 65536) → c.contextSize === 65536
  ```
  2^28 tokens of KV cache for stories260K is about 343 GB at f16, far above any RAM. If node-llama-cpp rejects that size with another error class, record its exact class and message in the bilan, and stop: the mapping would need a spec decision.

  In `tests/worker-model.test.mts`, add (letters follow the existing a–g):
  ```ts
  test('h. local_context 65536 on a model trained for 131072: the turn runs with 65536; set to max, the next turn reloads at 131072', { timeout: 300000 }, …)
    // gguf-add the patched copy, active_local_model, local_context 65536 → send; wait for the model event: contextWindow === 65536;
    // save-global-settings { local_context: 'max' } → send again → model event contextWindow === 131072
  test('i. max_tokens caps the engine context: 24576', { timeout: 180000 }, …)        // local_context 65536, max_tokens 24576 → model event contextWindow === 24576
  test('j. with NODE_LLAMA_CPP_GPU=false the model loads on the processor and answers', { timeout: 180000 }, …)
    // worker env adds NODE_LLAMA_CPP_GPU: 'false'; hardware-info.backend === 'cpu'; a turn on stories260K ends 'done' with non-empty text
  test('k. model-status before any load reports the planned window, not MIN_LOCAL_CONTEXT', { timeout: 30000 }, …)
    // patched (131072) active, default setting → contextWindow === 32768, loaded === false; stories260K active → 16384 (unchanged)
  ```
  The 0-layer assertion of the spec's no-card variant needs the placement in `model-status`, which T6 adds: T6 test l asserts it in the same setup.
- [ ] **Run:** `node --experimental-strip-types --test tests/local-engine.test.mts tests/worker-model.test.mts`.
  - Expect FAIL:
    - `loadLocalModel is not a function`;
    - h: first window 16384 or larger than 65536;
    - i: 32768;
    - k: 16384.
  - Test j may pass already. That is expected.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** both files, then the full suite alone. Expect PASS: **868/868** (861 + 3 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/local-engine.mts electron/core/active-model.mts electron/worker.mjs electron/tests/local-engine.test.mts electron/tests/worker-model.test.mts
  git commit -m "feat: deterministic local load — gpuLayers fitContext for the capped context, exact context size, reload on a changed setting, one French error when nothing fits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 5: Background estimate — cached, cancellable, prepared for a remote source

**Files:**
- Create: `electron/core/offload-estimate.mts`, `electron/core/estimate-jobs.mts`, `electron/tests/offload-estimate.test.mts`, `electron/tests/worker-estimate.test.mts`.
- Modify: `electron/worker.mjs` (ops `estimate-model`, `estimate-cancel`; event `estimate`; `turnProvider` cancels running estimates), `electron/main.cjs` (`allowed`), `electron/tests/main-routing.test.mts` (two `isBackendOp` assertions added), `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `runtimeLlama`, `backendOf`, `readHardware` (T2); `Placement`, `fitOf` (T2); `plannedContextSize`, `ContextRequest` (T4).
- `core/offload-estimate.mts`:
  ```ts
  export type ModelSource = { kind: 'file'; path: string } | { kind: 'remote'; url: string; etag?: string };
  export type EstimatePhase = 'stat' | 'read' | 'insights' | 'layers' | 'resources';
  export const REMOTE_ESTIMATE_LATER = "Estimation d'un modèle distant : pas encore disponible.";
  export const ESTIMATE_CACHE_LIMIT = 64;
  export interface HardwareKey { backend: Backend; gpuNames: string[]; vramTotal: number }
  export async function hardwareKey(): Promise<HardwareKey>;            // from readHardware(); vramTotal 0 on cpu
  export async function estimateKey(source: ModelSource, contextSize: number, hardware: HardwareKey): Promise<string>;
  // file: JSON.stringify(['file', resolvedPath, size, mtimeMs, contextSize, hardware]); remote: ['remote', url, etag ?? '', contextSize, hardware]
  export class EstimateCache {
    constructor(dataHome: string);                                          // <dataHome>/estimates.v1.json through JsonStore
    get(key: string): Promise<Placement | null>; set(key: string, placement: Placement): Promise<void>; // keeps the last 64 set
  }
  export async function estimatePlacement(source: ModelSource, options: { contextSize: number; signal?: AbortSignal; onPhase?(phase: EstimatePhase): void }): Promise<Placement>;
  ```
- **Algorithm of `estimatePlacement`.** The tests check the result, not the order, so the steps are given here. After each step the function calls `onPhase(step)`, then `signal?.throwIfAborted()`.
  1. `stat`: refuse `remote` with `REMOTE_ESTIMATE_LATER`;
  2. `read`: `readGgufFileInfo(path, { signal })`;
  3. `insights`: `GgufInsights.from(info, await runtimeLlama())`;
  4. `layers`: `insights.configurationResolver.resolveModelGpuLayersV2({ fitContext: { contextSize } }, opts)`, where `opts` holds the same values `LlamaModel.js:523` passes when `loadModel` is called with no extra option (`getVramState`, `llamaVramPaddingSize`, `llamaGpu`, `llamaSupportsGpuOffloading`, default flash-attention, KV-cache types, SWA), plus `signal`. An `InsufficientMemoryError` → `insufficient = true`, `gpuLayers = 0`;
  5. `resources`: `insights.estimateModelResourceRequirementsV2({ gpuLayers, useMmap })` + `estimateContextResourceRequirementsV2({ contextSize, modelGpuLayers: gpuLayers })` → `vramBytes`, `ramBytes`. Then `fit = fitOf({ …, ramTotal: os.totalmem(), insufficient })` and `source: 'estimate'`, `memoryMeasured: false`.

  Choice made here: the **fine resolver** (60–110 s on the 27B, measured by the recon), not the 10–20 s `scoreModelConfigurationCompatibility`. The recon showed the latter giving 28 layers where `fitContext` gives 31: a figure that differs from what is loaded is an anti-goal.
- `core/estimate-jobs.mts`:
  ```ts
  export type EstimateOutcome = { id: string; state: 'done'; estimate: Placement } | { id: string; state: 'cancelled' } | { id: string; state: 'error'; message: string };
  export class EstimateJobs {
    start(key: string, run: (signal: AbortSignal) => Promise<Placement>, onEnd: (outcome: EstimateOutcome) => void): { id: string; reused: boolean };
    cancel(id: string): boolean;   // true if it was running
    cancelAll(): void;
    get running(): number;          // 0 or 1
  }
  // same key while running → same id, reused: true; another key → the running job is cancelled first (one at a time);
  // an abort ends as 'cancelled', never 'error'; ended jobs are forgotten
  ```
- Worker:
  - `estimate-model` `{ modelId?: string }` → `{ estimateId: string | null; estimate: Placement | null }`:
    - the model is `modelId`'s library entry, or the active one;
    - none → `NO_LOCAL_MODEL`; unknown id or missing file → `LOCAL_MODEL_MISSING`;
    - `active.size > 0` → `ESTIMATE_BUSY`;
    - `contextSize = plannedContextSize(path, request)`;
    - a cache hit answers `{ estimateId: null, estimate }` with no event;
    - otherwise `jobs.start(...)`, answered at once. The job posts `{ type: 'event', event: 'estimate', estimateId, modelId, state, estimate?, message? }` and caches a `done` result.
  - `estimate-cancel` `{ estimateId }` → `{ cancelled: boolean }`.
  - `turnProvider` calls `jobs.cancelAll()` when it resolves a local model.
- `core/offload-estimate.mts` also exports `ESTIMATE_BUSY = 'Estimation impossible pendant une réponse du modèle : réessaie à la fin de la réponse.'`

**Steps:**
- [ ] **Write the failing tests.** `tests/offload-estimate.test.mts` (in-process, real node-llama-cpp):
  ```ts
  test('estimatePlacement on stories260K gives the same layers, total and backend as the real load', { timeout: 120000 }, …)
    // e = await estimatePlacement({ kind: 'file', path: stories }, { contextSize: 16384 }); e.source === 'estimate'; e.contextSize === 16384;
    // l = await loadLocalModel(stories, 16384); e.gpuLayers === l.gpuLayers; e.totalLayers === l.totalLayers; e.backend === l.backend; e.vramBytes + e.ramBytes > 0
  test('an abort during a phase rejects with AbortError and nothing is cached', { timeout: 60000 }, …)
    // for each phase of ['stat','read','insights','layers']: onPhase aborts when it sees that phase → rejects { name: 'AbortError' }; cache.get(key) === null
  test('the cache key follows the file size and mtime, the hardware and the context', async …)
    // same inputs → equal; utimes +1 s → different; contextSize 32768 → different; hardware { …, vramTotal + 1 } → different
  test('EstimateCache persists in estimates.v1.json and keeps the last 64', async …)
    // set 65 keys → a new EstimateCache(home) sees key 64 and not key 0; the file holds 64 entries
  test('a remote source is accepted by the type and refused with REMOTE_ESTIMATE_LATER', async …)
    // rejects { message: REMOTE_ESTIMATE_LATER }
  test('EstimateJobs: one key one job; another key cancels the running one; cancelAll aborts', async …)
    // run functions wait on their signal; start(k1) twice → same id, reused; start(k2) → k1 ends { state: 'cancelled' }; cancelAll → k2 'cancelled'; running === 0
  test('a real estimate with NODE_LLAMA_CPP_GPU=false: cpu backend, 0 layers, fit cpu', { timeout: 120000 }, …)
    // in a Worker eval (as local-engine.test.mts does for mintCallId) with env NODE_LLAMA_CPP_GPU 'false': estimate.backend === 'cpu', gpuLayers 0, fit 'cpu'
  ```
  `tests/worker-estimate.test.mts` (real `worker.mjs`, mkdtemp home, stories260K):
  ```ts
  test('estimate-model for the active model answers at once, then an estimate event; the second call is a cache hit', …)
    // r1.estimateId string, r1.estimate null; event { state: 'done', estimateId: r1.estimateId, modelId } with estimate.contextSize 16384;
    // r2 → { estimateId: null, estimate: deepEqual(event.estimate) }; estimates.v1.json exists in the home
  test('estimate-model during a turn is refused with ESTIMATE_BUSY', …)
    // send (stories active) → runId; immediately estimate-model → rejects { message: ESTIMATE_BUSY }; stop the run
  test('estimate-cancel of an unknown id answers { cancelled: false }', …)
  test('estimate-model with no active model is refused with NO_LOCAL_MODEL', …)
  ```
  In `main-routing.test.mts`, add `isBackendOp('estimate-model')` and `isBackendOp('estimate-cancel')` to the same test.
- [ ] **Run:** `node --experimental-strip-types --test tests/offload-estimate.test.mts tests/worker-estimate.test.mts tests/main-routing.test.mts`.
  - Expect FAIL: missing modules; `Opération IPC inconnue`.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the three files, then the full suite alone. Expect PASS: **879/879** (868 + 7 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/offload-estimate.mts electron/core/estimate-jobs.mts electron/worker.mjs electron/main.cjs electron/tests/offload-estimate.test.mts electron/tests/worker-estimate.test.mts electron/tests/main-routing.test.mts electron/tests/all.mts
  git commit -m "feat: background offload estimate — the loader's own resolver, cached on file + hardware + context, cancellable, refused during a turn" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 6: The placement in the model status, the bridge and the preload

**Files:**
- Create: `electron/renderer-src/src/components/model/placement.ts`, `electron/tests/placement-format.test.mts`.
- Modify:
  - core and main process: `electron/core/active-model.mts`, `electron/worker.mjs` (`postModelStatus` unchanged in shape, `turnModelStatus` now carries the placement), `electron/preload.cjs` (`onEstimateEvent`);
  - renderer: `ipc/types.ts`, `ipc/bridge.ts`;
  - tests: `electron/tests/worker-model.test.mts`, `electron/tests/bridge-connection.test.mts`, `electron/tests/preload-bridge.cjs` (window test, run in T13), `electron/tests/all.mts`.

**Interfaces:**
- `ModelStatus` (core and renderer mirror): `{ id; name; missing; contextWindow; loaded; placement?: Placement }`. `placement` is omitted when unknown, so the existing `deepEqual` tests a, e and g stay valid.
  - `modelStatus`: `loadedPlacement(path)`; else, only if `llamaCreated()`, the cached estimate for (path, planned size, `hardwareKey()`); else omitted. `model-status` never creates the Llama.
  - `turnModelStatus(model)`: `loadedPlacement(model.path) ?? undefined`.
- renderer `ipc/types.ts`: `Backend`, `Fit`, `Placement`, `HardwareInfo` (mirrors), and `EstimateEvent = { type: 'event'; event: 'estimate'; estimateId: string; modelId: string; state: 'done' | 'cancelled' | 'error'; estimate?: Placement; message?: string }`. `OpenAgentBridge.onEstimateEvent(callback)`.
- renderer `ipc/bridge.ts`:
  ```ts
  export function getHardwareInfo(refresh = false): Promise<HardwareInfo>;   // request('hardware-info', { refresh })
  export function estimateModel(modelId?: string): Promise<{ estimateId: string | null; estimate: Placement | null }>; // request('estimate-model', { modelId })
  export function cancelEstimate(estimateId: string): Promise<{ cancelled: boolean }>; // request('estimate-cancel', { estimateId })
  export function onEstimateEvent(listener: (event: Omit<EstimateEvent, 'type' | 'event'>) => void): () => void;
  ```
- `preload.cjs`: `onEstimateEvent`, filtered on `message.event === 'estimate'`, with an unsubscribe, like `onModelEvent`.
- renderer `components/model/placement.ts` (pure; imports `formatBytes` from `../../../../core/units.mts`):
  ```ts
  export function placementLabel(p: Placement): string;
  // gpu 'tout sur la carte' | split `${g}/${t} couches sur la carte` | cpu 'processeur seul' | none 'ne tient pas'; + ' (estimé)' when source === 'estimate'
  export function memoryLabel(p: Placement): string;
  // vramBytes > 0 ? `VRAM ${formatBytes(v)} · RAM ${formatBytes(r)} (estimé)` : `RAM ${formatBytes(r)} (estimé)` — always « estimé » (memoryMeasured is false)
  ```

**Steps:**
- [ ] **Write the failing tests.** `tests/worker-model.test.mts`:
  ```ts
  test('l. after a turn, model-status and the model event carry the loaded placement', { timeout: 180000 }, …)
    // status.placement.source === 'loaded'; deepEqual(status.placement, modelEvent.placement); status.placement.contextSize === status.contextWindow;
    // in the NODE_LLAMA_CPP_GPU=false worker (same setup as j): placement.gpuLayers === 0, backend 'cpu', fit 'cpu'
  test('m. before a load, model-status carries the cached estimate, marked estimate', { timeout: 180000 }, …)
    // hardware-info (creates the Llama) → estimate-model → event done → model-status.placement deepEqual the estimate, source 'estimate', loaded false
  ```
  `tests/placement-format.test.mts`:
  ```ts
  test('placementLabel: the four fits, « (estimé) » before the load only', () => …)
    // { fit:'gpu', source:'loaded' } → 'tout sur la carte'; { fit:'split', gpuLayers:31, totalLayers:63, source:'estimate' } → '31/63 couches sur la carte (estimé)';
    // { fit:'cpu', source:'loaded' } → 'processeur seul'; { fit:'none', source:'estimate' } → 'ne tient pas (estimé)'
  test('memoryLabel: VRAM and RAM, always « estimé »', () => …)
    // vram 6_549_000_000, ram 4_617_000_000 → 'VRAM 6,1 Gio · RAM 4,3 Gio (estimé)'; vram 0, ram 300 Mio → 'RAM 300 Mio (estimé)'
  ```
  `tests/bridge-connection.test.mts`:
  ```ts
  test('hardware and estimate bridges send their exact ops', async () => …)
    // getHardwareInfo() → { op: 'hardware-info', payload: { refresh: false } }; getHardwareInfo(true) → { refresh: true };
    // estimateModel('id1') → { op: 'estimate-model', payload: { modelId: 'id1' } }; cancelEstimate('e1') → { op: 'estimate-cancel', payload: { estimateId: 'e1' } }
  ```
  `tests/preload-bridge.cjs` (window test, not run here): add the same proof for `onEstimateEvent` as for `onAgentEvent`. Only the `estimate` event reaches it, and unsubscribing stops delivery.
- [ ] **Run:** `node --experimental-strip-types --test tests/worker-model.test.mts tests/placement-format.test.mts tests/bridge-connection.test.mts`.
  - Expect FAIL: `placement` undefined; missing module; `bridge.getHardwareInfo is not a function`.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the three files, then the full suite alone. Expect PASS: **884/884** (879 + 2 + 2 + 1). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/active-model.mts electron/worker.mjs electron/preload.cjs electron/renderer-src/src/ipc/types.ts electron/renderer-src/src/ipc/bridge.ts electron/renderer-src/src/components/model/placement.ts electron/tests/worker-model.test.mts electron/tests/placement-format.test.mts electron/tests/bridge-connection.test.mts electron/tests/preload-bridge.cjs electron/tests/all.mts
  git commit -m "feat: the model status carries the placement — loaded truth after a load, cached estimate before, French labels marked « estimé »" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 7: The « Matériel » tab, and the placement on the model button and dialog

**Decision: a new tab, not a section of an existing one.** The spec asks for « une section « Matériel » des réglages », holding three things:
- read-only machine data with a re-read button;
- a global setting that reloads the model;
- later, a download manager.

None of them belongs in Général (identity, theme-independent preferences, the Hugging Face token) or in Contexte & Mémoire, which is about the request budget, compaction and memory. The spec itself places « Contexte des modèles locaux » « dans la section Matériel ». A tab `hardware`, labelled « 🖥️ Matériel » and placed right after « 🧠 Contexte & Mémoire », keeps every existing tab's tests untouched, except the one assertion that lists the tabs.

**Files:**
- Create:
  - renderer: `components/settings/HardwareTab.tsx`, `components/settings/hardware-view.ts`;
  - tests: `electron/tests/hardware-view.test.mts`, `electron/tests/hardware-visual.cjs`, `electron/tests/run-hardware-visual.cjs`.
- Modify:
  - renderer: `components/settings/SettingsDialog.tsx`, `components/model/ModelButton.tsx`, `components/model/ModelDialog.tsx`;
  - `electron/package.json` (script `"test:hardware": "node tests/run-hardware-visual.cjs"`);
  - window tests, run in T13: `electron/tests/settings-visual.cjs` (8 tabs), `electron/tests/local-model-visual.cjs` (estimate, then loaded), `electron/tests/package-smoke.cjs` (the Matériel tab in the packaged app);
  - `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `getHardwareInfo`, `estimateModel`, `cancelEstimate`, `onEstimateEvent`, `getModelStatus`, `onModelEvent` (T6); `placementLabel`, `memoryLabel` (T6); draft `get/set` for `local_context` (T3 setting).
- `hardware-view.ts` (pure):
  ```ts
  export function hardwareLines(info: HardwareInfo): Array<{ field: 'backend' | 'gpu' | 'vram' | 'ram' | 'cpu' | 'notice'; text: string }>;
  // backend: `Moteur : ${{ cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', cpu: 'processeur seul' }[b]}`
  // gpu: `Carte : ${gpuNames.join(' + ')}` or 'Carte : aucune utilisée'
  // vram (only when vram !== null): `VRAM : ${formatBytes(total)} au total, ${formatBytes(free)} libres`
  // ram: `RAM : ${formatBytes(total)} au total, ${formatBytes(free)} libres`
  // cpu: `Processeur : ${model} — ${mathCores} cœurs de calcul`
  // notice (only when non-null): the notice text
  export const LOCAL_CONTEXT_OPTIONS: ReadonlyArray<{ value: LocalContextSetting; label: string }>;
  // [16384 '16k', 32768 '32k (défaut)', 65536 '64k', 131072 '128k', 'max' 'max du modèle']
  ```
- `HardwareTab.tsx`:
  - `<Section title="Matériel" badge="GLOBAL" />`, then the lines (`data-testid="oa-hardware-line"`, `data-field`);
  - a « Relire » button (`data-testid="oa-hardware-refresh-btn"`) that calls `getHardwareInfo(true)` and increments `data-reads` on `data-testid="oa-hardware"`;
  - a `<select data-setting="local_context">` from `LOCAL_CONTEXT_OPTIONS`, bound to the draft (saved by « Enregistrer » like every tab), under the help text « Plafonné par ce que le modèle supporte et par la limite de contexte (Contexte & Mémoire). Changer la valeur recharge le modèle au message suivant. »;
  - the CUDA block is added in Task 11.
- `ModelButton.tsx`:
  - the button's text and title are unchanged, because `model-selector-visual.cjs` and `final-e2e-lot13.cjs` assert them exactly;
  - a sibling chip `<span data-testid="oa-model-placement" data-source={placement.source}>{placementLabel(placement)}</span>` is rendered right after the button whenever `status.placement` exists;
  - it requests `estimateModel()` once per (`status.id`, `local_context`) when `status.id && !status.missing && !status.loaded && !status.placement`, and re-reads the status on the matching `estimate` event. An error (`ESTIMATE_BUSY`, a missing file) is silent here.
- `ModelDialog.tsx`, for the active entry:
  - `data-testid="oa-model-placement-detail"` holds `placementLabel` and `memoryLabel`;
  - while an estimate runs: « Estimation en cours… » with an « Annuler » button (`data-testid="oa-model-estimate-cancel"`, calls `cancelEstimate`);
  - on an `error` event: the message, passed through `cleanIpcError`.

**Steps:**
- [ ] **Write the failing test** `tests/hardware-view.test.mts`:
  ```ts
  test('hardwareLines in French for a card and for the processor alone; the context choices', () => …)
    // vulkan info { gpuNames: ['NVIDIA GeForce RTX 4060'], vram { total: 8_342_000_000, free: 6_549_000_000 }, ram { total: 34_270_000_000, free: 19_540_000_000 },
    //   cpu { model: 'AMD Ryzen 7 5800X 8-Core Processor', mathCores: 8 } } → deepEqual the 5 lines:
    //   'Moteur : Vulkan', 'Carte : NVIDIA GeForce RTX 4060', 'VRAM : 7,8 Gio au total, 6,1 Gio libres', 'RAM : 31,9 Gio au total, 18,2 Gio libres',
    //   'Processeur : AMD Ryzen 7 5800X 8-Core Processor — 8 cœurs de calcul'
    // cpu info → no 'vram' line, 'Moteur : processeur seul', 'Carte : aucune utilisée'; a notice → last line field 'notice'
    // LOCAL_CONTEXT_OPTIONS deepEqual the five pairs above
  ```
  The values above are test inputs, not measurements.
- [ ] **Run:** `node --experimental-strip-types --test tests/hardware-view.test.mts`. Expect FAIL: missing module.
- [ ] **Implement** per Interfaces.
- [ ] **Edit the window tests** (they are run once, in T13):
  - `settings-visual.cjs` lines 77–81: the tab ids are `['general', 'appearance', 'context', 'hardware', 'permissions', 'tools', 'folder', 'danger']`, with the message 'the 8 tabs: Matériel after Contexte'.
  - `hardware-visual.cjs`, a new file modelled on `settings-tabs-visual.cjs`: own Worker with `OPENAGENT_HOME=<mkdtemp>`, real built renderer. Steps:
    1. open the settings, then the `hardware` tab;
    2. wait for `[data-testid="oa-hardware-line"][data-field="backend"]`, which is absent before the first answer;
    3. assert each line equals `hardwareLines(await worker hardware-info)` for the fields `backend`, `gpu` and `cpu` (free memory moves, so `vram` and `ram` are only matched against `/^VRAM : .+ au total, .+ libres$/` and `/^RAM : …/`);
    4. click « Relire » and wait for `data-reads="2"`;
    5. select `65536`, press « Enregistrer », and check `config.json` holds `local_context: 65536`;
    6. take one capture.
  - `local-model-visual.cjs`, after the model is activated (line 109):
    - wait for `[data-testid="oa-model-placement"][data-source="estimate"]` (absent in the initial state) and assert its text ends with ' (estimé)';
    - after the real reply (line 114), wait for `[data-source="loaded"]` and assert its text does not contain 'estimé';
    - one capture each.
  - `package-smoke.cjs`, after the existing CDP checks: click `[data-testid="oa-settings-tab"][data-tab="hardware"]` through CDP and wait until `[data-field="backend"]`'s text matches `/^Moteur : (CUDA|Vulkan|Metal|processeur seul)$/`.
  - Before each edit, re-read the code each `waitFor` targets and ask what it returns on the initial state (lessons 2026-10-04 and 2026-10-18).
- [ ] **Run:** the test file, then the full suite alone. Expect PASS: **885/885** (884 + 1). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/renderer-src/src/components/settings/HardwareTab.tsx electron/renderer-src/src/components/settings/hardware-view.ts electron/renderer-src/src/components/settings/SettingsDialog.tsx electron/renderer-src/src/components/model/ModelButton.tsx electron/renderer-src/src/components/model/ModelDialog.tsx electron/package.json electron/tests/hardware-view.test.mts electron/tests/hardware-visual.cjs electron/tests/run-hardware-visual.cjs electron/tests/settings-visual.cjs electron/tests/local-model-visual.cjs electron/tests/package-smoke.cjs electron/tests/all.mts
  git commit -m "feat: « Matériel » settings tab (machine, re-read, local context) and the active model's split on the model button and dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 8: CUDA pack format and builder

**Gate:** Task 1 decision GO. Otherwise skip Tasks 8–12 and go to Task 13.

**Files:**
- Create: `electron/core/cuda-pack-format.mts`, `electron/scripts/cuda-pack.mts`, `electron/tests/cuda-pack-format.test.mts`.
- Modify: `electron/tests/all.mts`.

**Interfaces:**
- `core/cuda-pack-format.mts`:
  ```ts
  export const CUDA_PACK_FORMAT = 1;
  export const CUDA_PACK_CHUNK_BYTES = 1_900_000_000;               // < 2 GiB (2_147_483_648): « morceaux de moins de 2 Gio »
  export const CUDA_PACK_ALLOWED_PREFIXES = ['node_modules/@node-llama-cpp/win-x64-cuda/', 'node_modules/@node-llama-cpp/win-x64-cuda-ext/', 'cuda-runtime/'] as const;
  export interface PackFile { path: string; source: string }      // path: posix, relative, inside the pack
  export interface CudaPackManifest {
    format: 1; nodeLlamaCppVersion: string; platform: 'win-x64';
    parts: Array<{ name: string; size: number; sha256: string }>; downloadBytes: number; installedBytes: number; files: number;
  }
  export function partName(nodeLlamaCppVersion: string, index: number): string;  // `openagent-cuda-pack-${v}-win-x64.part${index}` (1-based)
  export function cudaPackUnsafePath(path: string): string;      // `Pack CUDA refusé : il contient un chemin non autorisé (${path}).`
  export function safePackPath(path: string): string;            // returns it, or throws cudaPackUnsafePath: absolute, '..' segment, backslash, outside the prefixes
  export async function writePack(files: PackFile[], outDir: string, options: { nodeLlamaCppVersion: string; chunkBytes?: number }): Promise<CudaPackManifest>;
  // writes outDir/<partName…> and outDir/manifest.json (2-space JSON, trailing newline)
  export async function extractPack(stream: AsyncIterable<Uint8Array>, destDir: string): Promise<{ files: number; bytes: number }>;
  ```
- **Archive bytes.** These must be reproducible across builds, so they are given here:
  - `gzip(level 9, header mtime 0)` of the records, files sorted by `path` (code-unit order);
  - each record is `uint32BE(headerLength) + JSON {"path","size","sha256"} + file bytes`;
  - the end record is `uint32BE(0)`;
  - the gzip stream is cut into parts of `chunkBytes`.
  - `extractPack` calls `safePackPath` before creating anything, writes each file, and checks its sha256 and size against its header. Any mismatch throws `CUDA_PACK_CORRUPT`, defined and exported here (T9 reuses it for part hashes): `export const CUDA_PACK_CORRUPT = "Pack CUDA corrompu (empreinte différente) : rien n'a été installé. Réessaie le téléchargement.";`
- `scripts/cuda-pack.mts`:
  ```ts
  export async function collectPackFiles(options: { nodeModules: string; runtimeDir: string; runtimePlacement: 'beside-binaries' | 'cuda-runtime' }): Promise<{ files: PackFile[]; nodeLlamaCppVersion: string }>;
  // both @node-llama-cpp packages (every file) + every *.dll of runtimeDir placed per D-CUDA-3;
  // throws `Version incohérente : ${pkg} ${v} au lieu de ${engine}` if a package's version differs from node-llama-cpp's
  // CLI: node --experimental-strip-types scripts/cuda-pack.mts --runtime <dir> [--out build/cuda-pack] [--placement beside-binaries|cuda-runtime]
  ```
  `--placement` defaults to the value Task 1 recorded as D-CUDA-3, written in the script as a constant with a comment pointing to the bilan.

**Steps:**
- [ ] **Write the failing tests** in `tests/cuda-pack-format.test.mts`. Fake input files are small real files written in a mkdtemp folder.
  ```ts
  test('writePack then extractPack restores every file byte for byte, and the manifest counts them', …)
  test('two builds of the same files are byte-identical, manifest included', …)
  test('parts are cut at chunkBytes, each part hash is in the manifest, and CUDA_PACK_CHUNK_BYTES is under 2 GiB', …)
    // chunkBytes 1000 on ~5 KB of incompressible data → ≥ 3 parts, all but the last exactly 1000; sha256 of each file on disk === manifest; CUDA_PACK_CHUNK_BYTES < 2 ** 31
  test('extractPack refuses a path outside the allowed prefixes before writing anything', …)
    // packs built with paths '../evil.dll', 'C:/evil.dll', 'node_modules/other/x.dll', 'cuda-runtime/../../x' → rejects { message: cudaPackUnsafePath(path) }; destDir empty
  test('collectPackFiles takes both packages and the runtime DLLs, and refuses a package of another engine version', …)
    // fake nodeModules tree with node-llama-cpp/package.json 3.21.1 and the two packages; runtime dir with two .dll and one .txt (ignored)
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/cuda-pack-format.test.mts`. Expect FAIL: missing modules.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the file, then the full suite alone. Expect PASS: **890/890** (885 + 5). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/cuda-pack-format.mts electron/scripts/cuda-pack.mts electron/tests/cuda-pack-format.test.mts electron/tests/all.mts
  git commit -m "feat: CUDA pack format — deterministic gzip record stream, parts under 2 GiB, manifest of hashes, path allow-list on extraction" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 9: CUDA pack installer — download, integrity, disk, cancel, uninstall, mismatch

**Files:**
- Create: `electron/core/cuda-pack.mts`, `electron/tests/support/fake-pack-server.mts`, `electron/tests/cuda-pack-install.test.mts`.
- Modify: `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `writePack`, `extractPack`, `CudaPackManifest`, `CUDA_PACK_CORRUPT` (T8); `formatBytes` (T2).
- `core/cuda-pack.mts`:
  ```ts
  export type CudaPackState = 'unavailable' | 'absent' | 'installing' | 'installed' | 'mismatch';
  export interface CudaPackStatus { state: CudaPackState; downloadBytes: number | null; installedBytes: number | null; installedVersion: string | null; expectedVersion: string }
  export const CUDA_PACK_MARGIN_BYTES = 268_435_456;
  export const CUDA_PACK_UNAVAILABLE = "Pack CUDA non disponible pour cette version de l'app.";
  export function cudaPackDiskNotice(required: number, free: number): string;
  // `Espace disque insuffisant pour le pack CUDA : il faut ${formatBytes(required)} libres, il en reste ${formatBytes(free)}.`
  export function cudaPackUrlRefused(url: string): string;          // `Adresse de téléchargement du pack CUDA refusée : ${url}`
  export function releaseBaseUrl(pkg: { version: string; build: { publish: unknown } }): string;
  // `https://github.com/${owner}/${repo}/releases/download/v${version}/` from the single github publish entry
  export async function freeBytes(dir: string): Promise<number>;     // fs.statfs: bavail * bsize
  export class CudaPack {
    constructor(options: { dataHome: string; manifestPath: string; baseUrl: string; engineVersion: string; allowLoopback?: boolean; freeBytes?: (dir: string) => Promise<number> });
    status(): Promise<CudaPackStatus>;
    install(options?: { signal?: AbortSignal; onProgress?(received: number, total: number): void }): Promise<CudaPackStatus>;
    uninstall(): Promise<CudaPackStatus>;
    installedDir(): Promise<string | null>;   // <dataHome>/cuda-pack/current if state === 'installed', else null
    finishPendingRemoval(): Promise<void>;
  }
  ```
- **States:**
  - `unavailable`: no readable manifest at `manifestPath`;
  - `installing`: an install of this instance is running;
  - `installed` / `mismatch`: `<dataHome>/cuda-pack/current/pack.json` exists (`{ nodeLlamaCppVersion, parts: string[] /* sha256 */, installedAt }`), and its version equals `engineVersion` (`installed`) or not (`mismatch`);
  - `absent` otherwise.
  - `expectedVersion` is always `engineVersion`.
- **Install order.** The tests pin each guard; the order is given here.
  1. If `freeBytes(dataHome) < installedBytes + CUDA_PACK_MARGIN_BYTES`, throw `cudaPackDiskNotice` before any request.
  2. Create `cuda-pack/.staging-<uuid>`.
  3. Stream the parts in order from `baseUrl + name`:
     - follow at most 5 redirects;
     - every URL must be `https:`, or `http://127.0.0.1:` only when `allowLoopback`; otherwise throw `cudaPackUrlRefused`;
     - hash each part, and pipe all parts, in order, into `extractPack(…, staging)`;
     - a part whose sha256 or size differs from the manifest throws `CUDA_PACK_CORRUPT`.
  4. Write `pack.json` last, inside staging.
  5. Remove the old `current` (uninstall path), rename staging → `current`.
  6. Any failure or abort removes staging, then rethrows. An abort rethrows the `AbortError`.
- **Uninstall:**
  1. delete `current/pack.json` first, so the pack is `absent` at once and never loaded again;
  2. `rm -r current`;
  3. on `EBUSY`/`EPERM`, a DLL is still mapped by this process: rename `current` to `.remove-pending-<uuid>` if Windows allows, else leave it. `finishPendingRemoval()`, called by the worker at start before any `getLlama`, removes every `.remove-pending-*` and any `current` without a `pack.json`.

**Steps:**
- [ ] **Write the failing tests.** `tests/support/fake-pack-server.mts`:
  ```ts
  export async function startFakePackServer(dir: string, options?: { bytesPerTick?: number; tamper?: string; redirectTo?: string }): Promise<{ url: string; requests: string[]; close(): Promise<void> }>;
  // serves dir's parts on 127.0.0.1:<random>; bytesPerTick throttles (one write per 50 ms); tamper flips one byte of that part; redirectTo answers 302 to it
  ```
  `tests/cuda-pack-install.test.mts`. Each test builds a small pack with `writePack` (fake DLL files under the allowed prefixes, `chunkBytes` 4096), a mkdtemp `dataHome`, and `engineVersion` `'3.21.1'`.
  ```ts
  test('status before install: absent, with the download and installed sizes of the manifest; no manifest → unavailable', …)
  test('install downloads every part, verifies it, and installs atomically', …)
    // onProgress last call (total, total); status installed; files equal the sources; no .staging-* left; installedDir() === <home>/cuda-pack/current
  test('a tampered part is refused with CUDA_PACK_CORRUPT, nothing installed, no staging left', …)
  test('not enough free space: refused before any request with the exact notice', …)
    // freeBytes: async () => 1000 → rejects { message: cudaPackDiskNotice(installedBytes + CUDA_PACK_MARGIN_BYTES, 1000) }; server.requests.length === 0
  test('cancel mid-download rejects with AbortError, removes the staging folder, status absent', …)
    // bytesPerTick 512; abort on the first onProgress
  test('uninstall removes the pack; a pending removal is finished at the next start', …)
    // install → uninstall → status absent, no current/; then a hand-made `.remove-pending-x/` and a `current/` without pack.json → finishPendingRemoval() → both gone
  test('an installed pack for another engine version is a mismatch and has no installedDir', …)
    // install with engineVersion '3.20.0', then new CudaPack(…, engineVersion '3.21.1').status() → { state: 'mismatch', installedVersion: '3.20.0', expectedVersion: '3.21.1' }
  test('URLs: https or loopback-for-tests only; redirects followed at most 5 times and never to http', …)
    // allowLoopback false with an http://127.0.0.1 base → rejects cudaPackUrlRefused(url); a 302 to http://example.invalid → refused; 6 chained 302 → refused;
    // releaseBaseUrl(real package.json) === 'https://github.com/JLSkyzer/openagenticskyzer/releases/download/v0.2.0/' (version read from the file, not hard-coded)
  test('freeBytes reads the real disk of a temp folder', …)   // > 0 and Number.isSafeInteger
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/cuda-pack-install.test.mts`. Expect FAIL: missing module.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the file, then the full suite alone. Expect PASS: **899/899** (890 + 9). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/cuda-pack.mts electron/tests/support/fake-pack-server.mts electron/tests/cuda-pack-install.test.mts electron/tests/all.mts
  git commit -m "feat: CUDA pack installer — sized before download, per-part hash, free-space check, cancel, atomic install, uninstall, engine-version mismatch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 10: CUDA in the engine, with fallback; the worker's pack ops

**Files:**
- Create: `electron/tests/support/fake-cuda-pack.mts`, `electron/tests/worker-cuda-pack.test.mts`.
- Modify:
  - core and main process: `electron/core/llama-runtime.mts`, `electron/core/hardware.mts` (`notice` from the runtime), `electron/worker.mjs`, `electron/main.cjs` (`allowed`, and `workerOptions` gains `cudaPackManifest`), `electron/preload.cjs` (`onCudaPackEvent`);
  - renderer: `ipc/types.ts`, `ipc/bridge.ts`;
  - tests: `electron/tests/test-seam.test.mts`, `electron/tests/main-routing.test.mts`, `electron/tests/bridge-connection.test.mts` (one assertion added to « hardware and estimate bridges… »), `electron/tests/preload-bridge.cjs`, `electron/tests/all.mts`.

**Interfaces:**
- Consumes: `CudaPack`, `releaseBaseUrl`, `CudaPackStatus` (T9); D-CUDA-2, -3, -4 (T1).
- `core/llama-runtime.mts` grows:
  ```ts
  export function setCudaPackSource(source: { installedDir(): Promise<string | null>; status(): Promise<CudaPackStatus> } | null): void;
  export function runtimeNotice(): string | null;
  export function restartRequired(installedDir: string | null): boolean;
  // D-CUDA-4 = restart: llamaCreated() && (installedDir !== null) !== createdWithPack; D-CUDA-4 = in-process: always false (a change bumps the generation instead)
  export function cudaFallbackNotice(backend: Backend): string;
  // `Le pack CUDA n'a pas pu se charger : l'app utilise ${backend === 'cpu' ? 'le processeur' : backend === 'vulkan' ? 'Vulkan' : backend} à la place.`
  export function cudaMismatchNotice(installed: string, expected: string): string;
  // `Le pack CUDA installé (moteur ${installed}) ne correspond plus à cette version de l'app (moteur ${expected}) : l'app utilise Vulkan. Télécharge le pack à jour.`
  ```
  `runtimeLlama()`:
  - with an installed pack, activate it per D-CUDA-2 (the `registerHooks` resolve hook for the two `@node-llama-cpp/win-x64-cuda*` specifiers, and the D-CUDA-3 DLL placement), then `getLlama({ gpu: 'cuda', build: 'never' })`;
  - on any throw, `getLlama({ gpu: { type: 'auto', exclude: ['cuda'] }, build: 'never' })` with `notice = cudaFallbackNotice(backendOf(fallback))`;
  - with status `mismatch`, the pack is never activated: plain `getLlama({ build: 'never' })` with `notice = cudaMismatchNotice(...)`;
  - the hooks are registered only inside a worker thread: never in the main thread, never in the in-process test runner.
- `main.cjs::workerOptions` → `{ type: 'module', workerData: { modelsDir, cudaPackManifest } }`. `cudaPackManifest` is `<resourcesPath>/cuda-pack/manifest.json` when packaged, `<appDir>/resources/cuda-pack/manifest.json` otherwise. Only a test passes `workerData.cudaPackBaseUrl`, and only a loopback URL is accepted: `allowLoopback = Boolean(workerData.cudaPackBaseUrl)`, and a non-loopback value is refused at worker start with `cudaPackUrlRefused`.
- Worker: at start, `new CudaPack({ dataHome, manifestPath: workerData.cudaPackManifest ?? <repo resources path>, baseUrl: workerData.cudaPackBaseUrl ?? releaseBaseUrl(package.json), engineVersion: getModuleVersion() })`, then `await finishPendingRemoval()`, then `setCudaPackSource(cudaPack)`. Ops:
  - `cuda-pack-status` → `CudaPackView = CudaPackStatus & { restartRequired: boolean; notice: string | null }`;
  - `cuda-pack-install` → `{ installId }`, answered at once. It is refused with `CUDA_PACK_UNAVAILABLE` (state `unavailable`), `Téléchargement du pack CUDA déjà en cours.` (installing) or `CUDA_PACK_BUSY` (`active.size > 0`). Progress posts `{ type: 'event', event: 'cuda-pack', installId, state: 'progress', receivedBytes, totalBytes }`, at most every 250 ms; the end posts `done` / `cancelled` / `error` (`message`);
  - `cuda-pack-cancel` `{ installId }` → `{ cancelled: boolean }`;
  - `cuda-pack-uninstall` → `CudaPackView`; refused with `CUDA_PACK_BUSY` during a turn;
  - `CUDA_PACK_BUSY = "Une réponse du modèle est en cours : attends la fin avant d'installer ou de désinstaller le pack CUDA."`;
  - `hardware-info.notice` = `runtimeNotice()`.
- renderer bridge: `getCudaPackStatus()`, `installCudaPack()`, `cancelCudaPackInstall(installId)`, `uninstallCudaPack()`, `onCudaPackEvent(listener)`; types mirrored.
- `tests/support/fake-cuda-pack.mts`: `export async function writeInstalledPack(dataHome: string, options: { engineVersion: string; corrupt: boolean }): Promise<void>`. It writes `cuda-pack/current/` with the real `dist/index.js` and `package.json` of `node_modules/@node-llama-cpp/win-x64-cuda` (version set to `engineVersion`), its real `_nlcBuildMetadata.json`, a 1 KB random `llama-addon.node` when `corrupt`, and `pack.json`.

**Steps:**
- [ ] **Write the failing tests** in `tests/worker-cuda-pack.test.mts` (real `worker.mjs`, mkdtemp home, `workerData.cudaPackManifest` = a manifest written by `writePack` in the temp root):
  ```ts
  test('1. a corrupt installed pack: the engine falls back with the exact notice, and a real turn still answers', { timeout: 300000 }, …)
    // writeInstalledPack(home, { engineVersion: <getModuleVersion()>, corrupt: true }); info = hardware-info → info.backend !== 'cuda';
    // info.notice === cudaFallbackNotice(info.backend); stories260K active → send → agent 'done' with non-empty text
  test('2. a pack of another engine version is never loaded: mismatch, Vulkan notice', { timeout: 120000 }, …)
    // writeInstalledPack(home, { engineVersion: '3.0.0', corrupt: false }); cuda-pack-status.state === 'mismatch';
    // hardware-info.backend !== 'cuda'; notice === cudaMismatchNotice('3.0.0', getModuleVersion())
  test('3. cuda-pack-install through the worker: progress events, then done; installed; uninstall → absent', { timeout: 120000 }, …)
    // workerData.cudaPackBaseUrl = fake server; ≥ 1 progress event with totalBytes === manifest.downloadBytes; done;
    // status { state: 'installed', restartRequired: false } (no Llama created in this worker yet); uninstall → state 'absent'
  test('4. installing or uninstalling during a turn is refused with CUDA_PACK_BUSY', { timeout: 180000 }, …)
  ```
  `test-seam.test.mts` line 105: the keys become `['modelsDir', 'cudaPackManifest']`. Add the two path assertions (packaged `C:\r\cuda-pack\manifest.json`, unpackaged `C:\a\resources\cuda-pack\manifest.json`); `testProviderModule` and `cudaPackBaseUrl` are absent. `main-routing.test.mts`: `isBackendOp` is true for the 4 `cuda-pack-*` ops. `bridge-connection.test.mts`: the 4 CUDA bridges send their exact ops and payloads. `preload-bridge.cjs`: `onCudaPackEvent` is filtered and can unsubscribe.
- [ ] **Run:** `node --experimental-strip-types --test tests/worker-cuda-pack.test.mts tests/test-seam.test.mts tests/main-routing.test.mts tests/bridge-connection.test.mts`.
  - Expect FAIL: `Opération IPC inconnue`, `notice` null, the `workerData` keys.
- [ ] **Implement** per Interfaces.
- [ ] **Run:** the four files, then the full suite alone. Expect PASS: **903/903** (899 + 4). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/core/llama-runtime.mts electron/core/hardware.mts electron/worker.mjs electron/main.cjs electron/preload.cjs electron/renderer-src/src/ipc/types.ts electron/renderer-src/src/ipc/bridge.ts electron/tests/support/fake-cuda-pack.mts electron/tests/worker-cuda-pack.test.mts electron/tests/test-seam.test.mts electron/tests/main-routing.test.mts electron/tests/bridge-connection.test.mts electron/tests/preload-bridge.cjs electron/tests/all.mts
  git commit -m "feat: an installed CUDA pack is tried first; corrupt or stale, the engine falls back to Vulkan/CPU with a French notice; worker ops to install, cancel and uninstall it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 11: The CUDA pack in the « Matériel » tab

**Files:**
- Modify: renderer `components/settings/HardwareTab.tsx`, `components/settings/hardware-view.ts`; `electron/tests/hardware-view.test.mts`; `electron/tests/hardware-visual.cjs` (window test, run in T13).

**Interfaces:**
- Consumes: the T10 bridge (`getCudaPackStatus`, `installCudaPack`, `cancelCudaPackInstall`, `uninstallCudaPack`, `onCudaPackEvent`, `restartApp` already in the bridge); `HardwareInfo.nvidia`.
- `hardware-view.ts`:
  ```ts
  export interface CudaPackUi { state: 'hidden' | 'unavailable' | 'absent' | 'installing' | 'installed' | 'restart' | 'mismatch' | 'failed'; text: string; button: null | { id: 'download' | 'cancel' | 'uninstall' | 'restart'; label: string } }
  export function cudaPackView(view: CudaPackView, info: HardwareInfo, progress: { received: number; total: number } | null): CudaPackUi;
  ```
  The states, in order of precedence:

  | Condition | `state` | `text` | `button` |
  |---|---|---|---|
  | `!info.nvidia && view.state !== 'installed'` | `hidden` | 'Aucune carte NVIDIA détectée : le pack CUDA ne servirait pas.' | none |
  | `view.state === 'unavailable'` | `unavailable` | `CUDA_PACK_UNAVAILABLE` | none |
  | `progress` set | `installing` | `Téléchargement du pack CUDA… ${Math.floor(100 * received / total)} %` | `cancel` 'Annuler' |
  | `view.state === 'mismatch'` | `mismatch` | the mismatch notice | `download` `Télécharger le pack à jour (${formatBytes(downloadBytes)})` |
  | installed, `info.notice` set | `failed` | the notice | `uninstall` 'Désinstaller' |
  | installed, `restartRequired` | `restart` | "Pack CUDA installé : redémarre l'app pour l'utiliser." | `restart` 'Redémarrer maintenant' |
  | installed | `installed` | "Pack CUDA installé : utilisé au prochain chargement d'un modèle." | `uninstall` 'Désinstaller' |
  | `absent` | `absent` | "Le pack CUDA accélère les cartes NVIDIA. Il est téléchargé depuis la release de l'app et installé dans son dossier de données." | `download` `Télécharger le pack CUDA (${formatBytes(downloadBytes)})` |

  The size is shown before any click, from the manifest.
- `HardwareTab.tsx`:
  - block `data-testid="oa-cuda-pack"` with `data-state`;
  - the button `data-testid="oa-cuda-${id}-btn"`;
  - the progress bar `data-testid="oa-cuda-progress"`;
  - errors through `cleanIpcError` in `data-testid="oa-cuda-error"`;
  - after `done`, `cancelled` or `error`, it re-reads `cuda-pack-status` and `hardware-info`.

**Steps:**
- [ ] **Write the failing test**, added to `tests/hardware-view.test.mts`:
  ```ts
  test('cudaPackView: hidden without NVIDIA, the size before download, progress and cancel, installed, restart, mismatch, failed', () => …)
    // one deepEqual per row of the table above, with downloadBytes 1_288_490_189 → 'Télécharger le pack CUDA (1,2 Gio)'
  ```
- [ ] **Run:** `node --experimental-strip-types --test tests/hardware-view.test.mts`. Expect FAIL: `cudaPackView is not a function`.
- [ ] **Implement** per Interfaces.
- [ ] **Edit `hardware-visual.cjs`.** Its worker gets `workerData: { cudaPackManifest: <tmp manifest>, cudaPackBaseUrl: <fake server url> }`, the pack being built with `writePack` from small fake files. Steps:
  1. The Matériel tab was read, so the Llama exists. If `info.nvidia`, `oa-cuda-pack` shows `data-state="absent"` and the download button's text equals `Télécharger le pack CUDA (${formatBytes(manifest.downloadBytes)})`. Without NVIDIA, assert `data-state="hidden"` and stop the CUDA steps there.
  2. Click download (server throttled at 512 bytes per tick), wait for `data-state="installing"`, click « Annuler », wait for `data-state="absent"`, and assert there is no `.staging-*` in `<home>/cuda-pack`.
  3. Restart the server without throttle and click download. Wait for `data-state` to be `restart` (D-CUDA-4 = restart) or `installed`, whichever the bilan recorded, and assert that exact one. Take a capture.
  4. Click « Désinstaller » when shown; wait for `absent`. In the `restart` state there is no uninstall button, so call `uninstallCudaPack` through the page's bridge and assert `absent`.

  Before the edit, re-read each `waitFor` against its initial state.
- [ ] **Run:** the test file, then the full suite alone. Expect PASS: **904/904** (903 + 1). Then both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/renderer-src/src/components/settings/HardwareTab.tsx electron/renderer-src/src/components/settings/hardware-view.ts electron/tests/hardware-view.test.mts electron/tests/hardware-visual.cjs
  git commit -m "feat: CUDA pack in the Matériel tab — size before download, progress and cancel, uninstall, restart or update offer, fallback notice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 12: The pack in the release — committed manifest, dry-run checks, upload after the draft

**Files:**
- Create:
  - `electron/resources/cuda-pack/manifest.json`, built locally from the real files: parts under `electron/build/cuda-pack/`, which the root `.gitignore` already covers with `build/`;
  - `electron/tests/cuda-real.cjs`: the manual real CUDA load, outside the suite.
- Modify: `electron/scripts/release-win.cjs`, `electron/package.json` (`"cuda-pack:build": "node --experimental-strip-types scripts/cuda-pack.mts"` and `extraResources` `{ "from": "resources/cuda-pack", "to": "cuda-pack" }`), `electron/tests/release-win.test.mts`, `electron/tests/package-smoke.cjs`.

**Interfaces:**
- `release-win.cjs` exports, in addition:
  ```js
  function packUploadArgs(version, repo, partPaths) // → ['release', 'upload', `v${version}`, ...partPaths, '--repo', repo]
  function assertPackMatchesManifest(manifest, builtDir) // throws:
  //   `Morceau du pack CUDA absent : ${name}` | `Morceau du pack CUDA différent du manifeste : ${name}` |
  //   `Morceau du pack CUDA trop gros (2 Gio ou plus) : ${name}` | `Le manifeste du pack CUDA ne correspond pas : lance npm run cuda-pack:build puis commite resources/cuda-pack/manifest.json.`
  ```
- `main(argv)`:
  - `--cuda-runtime <dir>` is required. Without it: `Dossier du runtime CUDA requis : --cuda-runtime <dossier>.`
  - It rebuilds the pack into `build/cuda-pack` with `scripts/cuda-pack.mts`, then runs `assertPackMatchesManifest(committed manifest, build/cuda-pack)`, after `assertReleasable`.
  - `--dry-run` additionally prints `dry-run: pack CUDA ${parts.length} morceau(x), ${downloadBytes} octets, conforme au manifeste` and uploads nothing.
  - The real path, after electron-builder's draft, runs `gh` with `packUploadArgs(...)`. It is never run in this lot.
- `tests/cuda-real.cjs`, run by Electron in two separate processes, because a backend is chosen per process (D-CUDA-4):
  - `--install`: serves `build/cuda-pack` on 127.0.0.1, then runs `worker.mjs` with `OPENAGENT_HOME=<given temp>`, `cudaPackManifest` = the committed manifest and `cudaPackBaseUrl` = loopback, and calls `cuda-pack-install`;
  - `--load`: the same home, no base URL. It activates `stories260K.gguf`, sends one message, and prints `hardware-info.backend`, the placement and the reply length;
  - PASS iff the backend is `cuda`, `placement.gpuLayers === placement.totalLayers` and the reply is non-empty.

**Steps:**
- [ ] **Write the failing tests** in `tests/release-win.test.mts`:
  ```ts
  test('packUploadArgs uploads every part to the draft of the version', () => …)
    // deepEqual(packUploadArgs('0.3.0', 'JLSkyzer/openagenticskyzer', ['a.part1', 'a.part2']), ['release','upload','v0.3.0','a.part1','a.part2','--repo','JLSkyzer/openagenticskyzer'])
  test('assertPackMatchesManifest refuses a missing part, another hash, a part of 2 GiB or more; accepts the built pack', async …)
    // a pack written by writePack in a temp dir; the size check uses a manifest entry of size 2 ** 31 (no 2 GiB file is written)
  test('the committed CUDA pack manifest: format 1, the installed node-llama-cpp version, every part under 2 GiB', …)
    // JSON.parse(resources/cuda-pack/manifest.json): format === 1; nodeLlamaCppVersion === node-llama-cpp's package.json version; parts.every(p => p.size < 2 ** 31)
  ```
  `package-smoke.cjs`: `release/win-unpacked/resources/cuda-pack/manifest.json` exists and is byte-equal to the committed one.
- [ ] **Run:** `node --experimental-strip-types --test tests/release-win.test.mts`. Expect FAIL: `packUploadArgs is not a function`, and the manifest file is missing.
- [ ] **Build the real pack once, locally.**
  1. `npm run cuda-pack:build -- --runtime <the S3 scratch runtime folder> --out build/cuda-pack`.
  2. Copy `build/cuda-pack/manifest.json` to `resources/cuda-pack/manifest.json`.
  3. Record in the bilan: the part count, `downloadBytes` and `installedBytes`, called measured (they are file sizes).
  4. Build a second time and check the manifests are byte-identical (determinism on the real files).

  The runtime DLLs come from the S3 scratch folder, which the user already approved. If it is gone, ask again before downloading.
- [ ] **Implement** per Interfaces.
- [ ] **Run:**
  1. the test file;
  2. `node scripts/release-win.cjs --dry-run --cuda-runtime <scratch runtime> > ../.superpowers/runs/release-dry-run.log 2>&1; echo exit $?`, ONCE. Check that the log has no token: the `gh auth token` value never appears, only its length. A refusal for an unpushed commit or a dirty tree is the expected outcome mid-lot; record it, do not work around it;
  3. the full suite alone. Expect PASS: **907/907** (904 + 3).
  4. both `tsc` and `renderer:build`.
- [ ] **Commit:**
  ```
  git add electron/resources/cuda-pack/manifest.json electron/scripts/release-win.cjs electron/package.json electron/tests/release-win.test.mts electron/tests/package-smoke.cjs electron/tests/cuda-real.cjs
  git commit -m "feat: the release builds the CUDA pack, checks it against the committed manifest (dry-run included) and uploads its parts to the same draft" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

## Task 13: Window proofs, packaged app, real measurement, closure

**Files:**
- Modify: `README.md` (one line under the features: « **Matériel** : moteur, carte, VRAM, RAM et processeur affichés ; répartition carte / processeur de chaque modèle, estimée puis réelle ; pack CUDA optionnel pour les cartes NVIDIA. »; drop the CUDA clause if Tasks 8–12 were skipped), `tasks/todo.md` (bilan), `tasks/lessons.md`, this plan (bilan).
- Fix only what a run proves wrong, in the task's spirit, and say so in the bilan.

**Steps:**
- [ ] **Pre-flight, before any window run.**
  - Full suite alone (**907/907**, or **885/885** if Tasks 8–12 were skipped), both `tsc` (core 5, renderer 0), `npm run renderer:build`.
  - Re-read every `waitFor` and assertion of the window tests below against the code they target, asking what each gives on the initial state. Fix a test before its single run, never after.
- [ ] **Dev window tests, each ONCE**, from `electron/`, each `npm run <script> > ../.superpowers/runs/<script>.log 2>&1; echo exit $?`. On failure: report the log and the capture, never re-run.
  - `test:settings`: `settings-visual.cjs`, 8 tabs (T7);
  - `test:hardware`: `hardware-visual.cjs` (T7, T11);
  - `test:localmodel`: `local-model-visual.cjs` (T7);
  - `test:preload`: `preload-bridge.cjs` (T6, T10).

  That is 4 runs, exactly the window tests edited in Tasks 6–12. `test:model` (`model-selector-visual.cjs`) is not edited: the button text is unchanged by design.
- [ ] **Packaged app, ONCE each.**
  - `npm run package:win > ../.superpowers/runs/package-win.log 2>&1; echo exit $?` must exit 0. Check:
    - `app.asar` contains `core/llama-runtime.mts`, `core/hardware.mts` and `core/offload-estimate.mts`, and no `tests/`;
    - with CUDA, `release/win-unpacked/resources/cuda-pack/manifest.json` exists;
    - no `@node-llama-cpp/win-x64-cuda*` folder is in `app.asar.unpacked`: the pack is never shipped inside the installer.
  - `npm run test:package > ../.superpowers/runs/test-package.log 2>&1; echo exit $?`. This proves « la section « Matériel » s'affiche » in the packaged app, the build an install would put on disk. `test:install` is NOT run: it installs and uninstalls on the user's real machine profile, which this lot does not need.
  - Look at every capture. Then `tasklist | grep -i -E "openagent|electron"` must show nothing left.
- [ ] **Manual real CUDA load (only if Tasks 8–12 ran), controller-run, ONCE:** `electron tests/cuda-real.cjs --install <tmp>` then `electron tests/cuda-real.cjs --load <tmp>`, each into its own log file. Record the outcome as « vérification manuelle ». No test downloads the real pack: this one is served from the local build.
- [ ] **Real measurement on the user's machine (manual, controller-run, with the user present to pick the file).**
  1. Launch `release/win-unpacked/openagent.exe` with `OPENAGENT_HOME=<mkdtemp>`, `OPENAGENT_USERDATA_DIR=<mkdtemp>` and `--user-data-dir=<same>`. This is an isolated test app: the user's real library and `%USERPROFILE%\.openagent` are never opened.
  2. In the model dialog, « Importer » → the user picks his 27B IQ3_M in his Downloads folder. The library only records the path: the file is opened read-only by the loader, never moved, copied or written.
  3. Settings › Matériel: note the hardware lines; keep « Contexte des modèles locaux » at 32k.
  4. Note the estimate on the button and in the dialog (« estimé »), and the time it took (stopwatch).
  5. Before sending, read `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` and the RAM in use (Task Manager › Performance).
  6. Send one short message. Note the load time, then the displayed placement (layers, VRAM, RAM) once « estimé » is gone.
  7. Read `nvidia-smi` again, and the process memory in Task Manager (« openagent », private working set).
  8. Write in the bilan a table: displayed estimate / displayed loaded / observed. Mark each figure « mesuré » (observed with nvidia-smi or Task Manager) or « estimé » (shown by the app), and explain any gap (other processes, mmap, the loader's padding). If the CUDA pack is installed, do the same once on CUDA after an app restart.
  9. Close the app; delete both temp folders.
- [ ] **Static closure checks.**
  - `git grep -n "contextSizeFor\|Floored at 4096" -- electron/core` prints nothing.
  - `git grep -n "getLlama(" -- electron/core electron/worker.mjs` shows only `core/llama-runtime.mts`, and every call has `build: 'never'`.
  - `git diff --stat ea3e07e..HEAD -- electron/core/web-tools.mts electron/core/hf-token.mts` prints nothing: no tool removed.
- [ ] **Bilan in `tasks/todo.md`**, « Bilan du lot — matériel et débordement (2026-10-18) »:
  - per spec objective 1–6: the proof (test names, window runs and their single outcome, the manual checks) and the commit;
  - the decisions: Matériel as a tab; the context rule; the fine resolver; the persisted cache; one estimate at a time, cancelled by a turn and refused during one; memory always « estimé »; the pack format; D-CUDA-1…4; `build: 'never'`;
  - the known limits:
    - the estimate can differ from the load when free VRAM changed in between (spec decision);
    - a pack change may need an app restart (D-CUDA-4);
    - the remote estimate source is typed but not implemented (project 2);
    - the release upload path was never run (dry-run only).
  - What is not proven: no run on a machine without NVIDIA or without Vulkan; no real publication.
- [ ] **Lessons.** Add `tasks/lessons.md` lines only for what went wrong in this lot (`date | what | cause | rule`). At the end, propose to the user grouped, verified notes for `D:\BDC` (user memory: BDC at each lot's end). Candidates, if confirmed:
  - node-llama-cpp's `memoryUsage` is an assumed footprint, not a measurement;
  - the CUDA packages carry no NVIDIA runtime;
  - prebuilt resolution through bare `@node-llama-cpp/*` imports, and what D-CUDA-2 found;
  - `fitContext` vs `scoreModelConfigurationCompatibility` layer counts differ;
  - same-named ggml DLLs across backends (D-CUDA-4).
- [ ] **Commit:**
  ```
  git add README.md tasks/todo.md tasks/lessons.md docs/superpowers/plans/2026-10-18-hardware-and-offload.md <any test fixed in pre-flight>
  git commit -m "docs: hardware and offload delivered — bilan, window proofs, packaged proof, real 27B measurement, lessons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push origin master
  ```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Obj. 1: engine, card, VRAM total/free, RAM total/free, CPU and math cores, in « Matériel », read by the worker via node-llama-cpp and `os`, a re-read button | T2 (`hardware.test` 1, 3), T7 (`hardware-view`, `hardware-visual` steps 3–4) |
| Obj. 2: explicit `fitContext` load; loaded figure is the truth; clear French error when 0 layers does not fit; nothing half-loaded | T4 (local-engine 1, 2), T6 (l) |
| Obj. 3: context = floor / setting / train / `max_tokens`; no growth with free memory; small model keeps 16 384 | T3 (rule table), T4 (h, i, k) |
| Obj. 4: button and dialog show N/M layers / all / CPU only, VRAM and RAM, estimate marked; via the `model` event and `model-status` | T6 (l, m, labels), T7 (button chip, dialog, `local-model-visual`) |
| Obj. 5: estimate op: layers, VRAM/RAM, fit indicator; cache key; cancellable; background; remote source prepared | T5 (all), T6 (m) |
| Obj. 6: CUDA pack: size first, integrity, disk, cancel, next load, uninstall; fallback with message; no pack → today's behaviour | T8–T11; T2/T4 unchanged path when absent |
| Décision: « Contexte des modèles locaux » 16k–128k/max, default 32 768, reload at next message, `max_tokens` unchanged | T3, T4 (h), T7 (select) |
| Décision: pack built and published with each release, < 2 Gio parts, embedded hashes, licence checked first, mismatch → Vulkan + offer, dry-run only | T1 (licence), T8, T10 (2), T11 (mismatch row), T12 |
| Décision: memory measured only if measured; otherwise « estimé » | Architecture note + T6 `memoryLabel` (always « estimé ») |
| Décision: final measurement on the user's 27B in an isolated app | T13 |
| Anti-goals: displayed ≠ loaded; frozen UI; pack preventing start or leaving no engine; estimate shown as measure | T5 (1), T6 (l); T5 (op answers at once, event-based); T9 (`finishPendingRemoval` before `getLlama`), T10 (1, 2); T6 labels |
| Constraints: real tests, isolated home, window tests once, no real pack download, public repo, measured-only figures | Global Constraints; T13 |
| Verification list: suite, tsc ×2, build; real load equality and `gpu: false`; capped context; estimate cache/cancel/indicator; pack vs fake server; window tests once; packaged Matériel; real measurement | T2–T12 each; T4 (j), T6 (l); T13 |

**Step scan:** every step names files, values and commands. There are no « TBD » and no « handle edge cases ». The only open items are the spike outcomes, which have pinned decision rules (D-CUDA-1…4), each with both branches written out.

**Type consistency:**
- `Placement`, `Fit` and `Backend` are defined once (T2, `core/placement.mts`) and mirrored in renderer `types.ts` (T6) with the same fields.
- `ContextRequest` (T4) is consumed by T5. `LocalContextSetting` (T3) is consumed by T4 and T7.
- `HardwareInfo` (T2) gains a non-null `notice` source in T10 without a shape change.
- `CudaPackStatus` (T9) is extended to `CudaPackView` (T10), consumed by `cudaPackView` (T11).
- `workerOptions` keys: `['modelsDir']` → `['modelsDir', 'cudaPackManifest']` in T10, the same task that updates `test-seam.test.mts`.
- Test counts: 853 → 857 → 861 → 868 → 879 → 884 → 885 → 890 → 899 → 903 → 904 → 907, each from the tests the task adds (no task removes a test).

**Review Focus coverage:**
1. → T5 test 1, T4 test 1, T6 test l, T13 measurement.
2. → T4 test 2.
3. → T3 test 1, T4 tests h, i, k.
4. → T10 tests 1, 2.
5. → T8 test 4, T9 tests 3, 4, 5, 8.

**Proportion:** signatures, pinned values, test names and assertions. Written-out algorithms are limited to what the tests cannot pin: the estimate's phase order and resolver options (T5), the archive byte layout (T8), the install and uninstall order (T9), and the context rule's justification (T3).

---

## Bilan — Task 1 (spike CUDA)

Run on 2026-10-18 on the user's machine. Everything was written to a `mkdtemp` scratch folder outside the repository, which was deleted afterwards. No repository file changed except this section.

**S1 — Inventory.**
- `electron/node_modules/@node-llama-cpp/win-x64-cuda` (3.21.1) has 22 files:
  - `LICENSE` (MIT, « Copyright (c) 2024 Gilad S. »), `README.md`, `package.json`, `dist/index.js`;
  - in `bins/win-x64-cuda/`:
    - `ggml-cuda.dll`: 144 822 784 bytes;
    - `llama-common.dll`: 8 203 264 bytes;
    - `llama.cuda.v0.4.0.dll`: 7 103 488 bytes;
    - 9 `ggml-cpu-*.dll`: 0.8–1.1 MB each;
    - `ggml-base.dll`: 1 290 752 bytes;
    - `llama-addon.node`, `.lib` and `.exp`: 0.95 MB, 2.7 MB and 1.6 MB;
    - `ggml.cuda.v0.4.0.dll` and `_nlcBuildMetadata.json` (llama.cpp release `v0.4.0`).
- `win-x64-cuda-ext` holds `bins/win-x64-cuda/fallback/ggml-cuda.dll` (367 827 968 bytes), plus `LICENSE` (MIT), README, `package.json` and `dist/index.js`. Neither package ships an NVIDIA DLL or an NVIDIA licence.
- PE import tables, read with a Node PE reader. It parsed the import directory and the delay-import directory.
  - **Main `ggml-cuda.dll` (CUDA 13):**
    - Imports `cublas64_13.dll`, `ggml-base.dll`, the MSVC runtime and `api-ms-win-crt-*`.
    - No `cudart64_*` is imported, yet the CUDA runtime API symbols are present, so **cudart is linked statically**.
    - `nvcuda.dll` is not imported. It appears only as a string and is loaded at runtime from the driver, as the S4 module list confirms.
  - **`fallback/ggml-cuda.dll` (CUDA 12):** imports `cudart64_12.dll`, `cublas64_12.dll`, `nvcuda.dll`, `ggml-base.dll` and the MSVC runtime.
  - **From the archive (S3):** `cublas64_13.dll` imports `cublasLt64_13.dll` and `KERNEL32.dll`. `cublasLt64_13.dll` imports only `KERNEL32.dll`.
- `nvidia-smi`: NVIDIA GeForce RTX 4060, 8188 MiB, driver **616.92**. This nvidia-smi version prints « CUDA UMD Version: 13.4 » instead of « CUDA Version ».
- No CUDA Toolkit is installed: `CUDA_PATH` is empty and no `cublas*` or `cudart*` is on `PATH` or in System32. The tests below therefore depend only on the pack.
- DLLs the pack carries, from NVIDIA `libcublas` 13.8.0.4:
  - `cublas64_13.dll`: 54 873 200 bytes;
  - `cublasLt64_13.dll`: 493 474 416 bytes.
- Not carried:
  - `nvcuda.dll` belongs to the display driver.
  - The CUDA 12 fallback would also need `cudart64_12.dll` (`cuda_cudart` 12.x) and `cublas64_12.dll` + `cublasLt64_12.dll` (`libcublas` 12.x). The user did not approve those archives, and S4 shows they are not needed.

**S2 — Licence.**
- Sources:
  - The NVIDIA CUDA Toolkit EULA at https://docs.nvidia.com/cuda/eula/index.html, for CUDA Toolkit v13.4. Its header says « Last updated: January 26, 2026 », and its page footer says Oct 12, 2026. It has no separate version number.
  - The `LICENSE` inside the `libcublas` 13.8.0.4 archive (68 070 bytes), which carries the same January 26, 2026 date.
  - The `cuda_cudart/LICENSE.txt` and `libcublas/LICENSE.txt` pages under `developer.download.nvidia.com/compute/cuda/redist/`. These are identical and older (January 12, 2024), with the same Attachment A entries and the same §1.1.2 requirements.
- Attachment A (§2.6) lists, for Windows:
  - « CUDA Runtime »: `cudart.dll`;
  - « CUDA BLAS Library »: `cublas.dll` and `cublasLt.dll`.
- Its introduction covers file names carrying a version number, with `cudart64_90.dll` as the example. So `cublas64_13.dll`, `cublasLt64_13.dll`, `cublas64_12.dll`, `cublasLt64_12.dll` and `cudart64_12.dll` are all redistributable.
- Conditions (§1.1.1–1.1.2, §2.1, Attachment B), paraphrased:
  - the DLLs ship in object form inside an application with material additional functionality;
  - only that application may use them;
  - our distribution terms must stay consistent with the EULA and protect NVIDIA's IP, so the DLLs must not be relabelled MIT;
  - we report known non-compliant use to NVIDIA;
  - the application targets systems with NVIDIA GPUs;
  - part of cuBLAS comes from Vasily Volkov / UC Berkeley under a BSD licence, so a binary redistribution must reproduce its copyright notice. NVIDIA's `LICENSE` therefore ships inside the pack.
- The node-llama-cpp packages are MIT: `electron/node_modules/@node-llama-cpp/win-x64-cuda/LICENSE` and `.../win-x64-cuda-ext/LICENSE`.

**S3 — Runtime fetched.** The user approved one archive only: `libcublas-windows-x86_64-13.8.0.4-archive.zip`, from `https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/`. It is listed in `redistrib_13.4.3.json` (release 2026-10-13).
- Size: 422 415 931 bytes, matching the manifest.
- sha256: `0974318e9861a61cb9091cf7de8d4c2880e9787fe311cb4bcbd08865663c5f43`, matching the manifest.
- Unpacked: only the two DLLs and `LICENSE`. `nvblas64_13.dll` is in the archive but is not needed.

**S4 — Loading outside `node_modules`.**
- Setup:
  - Electron 44.4.2 (Node 24.21.0), headless, with no window.
  - The main process starts a `worker_threads` Worker of type module, as `main.cjs` does.
  - `OPENAGENT_HOME` and `userData` point to temp folders.
  - In the worker, `module.registerHooks({ resolve })` maps both bare specifiers to `<scratch>/pack*/node_modules/@node-llama-cpp/<name>/dist/index.js`. `getBinsDir()` then reported the scratch path, with version 3.21.1.
- Control, without the hook (repository packages, no NVIDIA DLL): node-llama-cpp printed « The prebuilt binary … with CUDA support is not compatible with the current system », followed by `NoBinaryFoundError`.
- **A, DLLs beside `ggml-cuda.dll`: failed.**
  - The child-process binary test's stderr: « Binary GPU type mismatch. Expected: cuda, got: false … »
  - Cause: the Windows loader does not search the folder of the DLL that `ggml` loads for its dependencies.
- **B, DLLs in `<pack>/cuda-runtime/`, prepended to `process.env.PATH` by the main process before creating the Worker: succeeded.**
  - The binary test passed, and `llama.gpu === 'cuda'` on the RTX 4060.
  - `loadModel(stories260K, gpuLayers: { fitContext: { contextSize: 16384 } })` gave `model.gpuLayers` = 6 of 6, and the 4-token generation returned text.
  - Loaded build: the **main CUDA 13 build**, not `fallback/`. The log said « loaded CUDA backend from …\win-x64-cuda\bins\win-x64-cuda\ggml-cuda.dll ».
  - The process module list showed `cublas64_13.dll` and `cublasLt64_13.dll` loaded from `cuda-runtime/`, and `nvcuda.dll` from System32.
- **C, `CUDA_PATH` instead of `PATH`: failed**, with the same « got: false » as A. `CUDA_PATH` feeds node-llama-cpp's detection, not the OS loader.

**S5 — Backend switch in one process**, mechanism B, in one worker, with every object disposed between steps:
- Vulkan, then CUDA: both loaded, offloaded 6 of 6 layers and generated text. Likewise in the reverse order. Neither crashed.
- The module list explains why this is not a clean switch.
  - After disposal, the first backend's DLLs stay loaded.
  - The second backend's `llama-addon.node`, `ggml-cuda.dll` (or `ggml-vulkan.dll`) and `llama.*.dll` load from its own folder. Its `ggml-base.dll`, `llama-common.dll` and `ggml-cpu-haswell.dll` do not: Windows reuses the modules already loaded under those names.
  - Those files differ between the Vulkan and CUDA folders (different sha256; `ggml-base.dll` is 1 281 536 bytes for Vulkan and 1 290 752 for CUDA).
  - So the second backend ran on the first backend's base libraries. It worked here, on a 260K model and a 4-token generation, but nothing guarantees it.

**S6 — Sizes.**
- Raw bytes are measured (file sizes). The gzip figures are **estimates**: each file was gzipped once with `zlib.gzipSync` at level 9.
- Proposed pack: the `win-x64-cuda` package plus `cublas64_13.dll`, `cublasLt64_13.dll` and NVIDIA's `LICENSE`.
  - Package: **175 510 346** bytes raw, ≈ 138 539 707 gzip.
  - NVIDIA runtime: **548 415 686** bytes raw, ≈ 423 076 369 gzip.
  - Total: **723 926 032 bytes raw (≈ 690 MiB)**, estimated **≈ 561 616 076 bytes gzip (≈ 536 MiB)**.
- `win-x64-cuda-ext` would add 367 830 717 bytes raw (≈ 175 416 838 gzip, estimated). It is useless without the CUDA 12 runtime, which this pack does not carry. The `.lib` and `.exp` files (≈ 4.3 MB) are not needed at runtime.

**Decisions.**
- **D-CUDA-1, licence: GO.**
  - `cublas64_13.dll` and `cublasLt64_13.dll` are on Attachment A.
  - The project meets the conditions: the app adds material functionality, the pack is offered only for NVIDIA GPUs, and NVIDIA's `LICENSE` is shipped inside the pack with the DLLs labelled NVIDIA-licensed, not MIT.
- **D-CUDA-2, mechanism: B.** The worker uses a resolve hook for `@node-llama-cpp/win-x64-cuda`. The main process prepends the runtime folder to `PATH` before creating the Worker.
- **D-CUDA-3, runtime placement: `cuda-runtime/`.** The pack does not ship `win-x64-cuda-ext`. Only the main CUDA 13 build is used.
- **D-CUDA-4, switch: next app start.**
  - The loader reuses `ggml-base.dll` and `llama-common.dll` across backends, and DLLs are not unloaded on dispose. The in-process switch therefore mixes binaries from two builds, even though S5 did not crash.
  - A pack install or removal sets `restartRequired`, and « Redémarrer maintenant » reuses `restart-app`.
  - The spec's « utilisation au prochain chargement » becomes « au prochain démarrage de l'app ».
  - The `PATH` change must also happen in the main process before the Worker starts, which is only possible at start-up.

**Concerns.**
- The download is about 536 MB (estimate).
- cuBLAS 13.8 comes from toolkit 13.4.3. The minimum driver this imposes on other machines has not been measured; this machine's driver 616.92 supports 13.4.
- Other machines without a CUDA 13 driver will fail the binary test. The app must then fall back cleanly to Vulkan (Task 10).

## Bilan — Task 13

Run on 2026-10-21 on the user's machine (RTX 4060, 8188 MiB; Electron 44.4.2). Every window, packaged and manual run below was run once. The full bilan, with the proof of each spec objective, the decisions and the known limits, is in `tasks/todo.md`, « Bilan du lot — matériel et débordement ».

**Runs and outcomes (one each).**
- Pre-flight: full suite 937/937, core `tsc` 5 (baseline), renderer `tsc` 0, `renderer:build` ok. The `waitFor` of `local-model-visual.cjs` was true on the initial state (`#oa-model-btn` is always on the page); fixed before its run to wait for the active folder entry. Also folded in: `packUploadError` (a failed pack upload says the draft is incomplete and how to finish) and `cuda-real.cjs` listening for the turn end before sending (3a0b7c6).
- Window tests: `test:settings`, `test:hardware`, `test:localmodel`, `test:preload` all PASS.
- Packaged: `package:win` exit 0 (asar has `llama-runtime`, `hardware`, `offload-estimate`, no `tests/`; manifest byte-equal; no `win-x64-cuda*` in `app.asar.unpacked`); `test:package` PASS. `test:install` not run.
- Manual real CUDA load (stories260K, pack served from loopback): install PASS (561 616 523 B, restart required), load PASS (cuda, 6/6, ctx 16 384).
- Static checks: no `contextSizeFor`; `getLlama(` only in `llama-runtime.mts`, `build: 'never'`; no diff on `web-tools.mts` and `hf-token.mts`.

**Real measurement, 27B IQ3_M, ctx 32k.** « mesuré » = per-process perf counters or `nvidia-smi`; « estimé » = shown by the app or announced by llama.cpp.

| Session | Estimate shown (estimé) | Loaded shown | Observed (mesuré) |
|---|---|---|---|
| 1. Vulkan, old padding | 25/66 · VRAM 5.9 GiB · RAM 8.5 GiB | 25/66 | `nvidia-smi` +2322 MiB; worker dedicated 2283 MiB + shared 3860 MiB; system RAM +10.3 GiB |
| 2. Vulkan, padding 1591 MiB | 18/66 · VRAM 4.6 GiB · RAM 9.9 GiB | 18/66; llama.cpp buffers ≈ 4690 MiB (estimé) | dedicated 2735 MiB + shared ≈ 2.1 GiB; `nvidia-smi` 4437/8188 MiB (≈ 3.7 GiB free); first word ≈ 5 min, reply ≈ 6 min (user's observations, minute precision) |
| 3. CUDA (pack installed) | not read | 25/66; llama.cpp buffers ≈ 6050 MiB (estimé) | dedicated 6223 MiB + shared 142 MiB; `nvidia-smi` ≈ 7.5/8.2 GiB; 2nd reply: tool call ≈ 18:00, end 18:01 (user); the 1st reply's time was not recorded |

**Fix wave after the final review (56a6761).**
- C-1: the packaged app could not install the CUDA pack (electron-builder strips `build` from the asar `package.json`, so the release URL was empty). The URL now comes from `repository`; a pack with no valid source is « unavailable », never offered; `package-smoke` asserts it on the asar copy. Verified in the packaged app.
- I-1: Vulkan on Windows gets a VRAM padding of `min(20 %, 2.5 GiB)` on the single runtime Llama; each load logs one `[placement]` line and llama.cpp's buffer sizes; estimates move to `estimates.v2.json`.
- M-2: a busy estimate is a result, not a logged error.
- M-3: the « Moteur » select fits its longest label (numeric assertion only; captures not viewed).

**The I-1 hypothesis is refuted.** The review thought Vulkan overstated free VRAM by about 1 GiB (probe: Vulkan free 7188 MiB vs `nvidia-smi` 6193 MiB), causing an over-commit that WDDM demotes to shared memory. With the larger padding (session 2) about 2 GiB still lands in shared memory while about 3.7 GiB of VRAM are physically free. The padding is harmless but is not the cause; the cause is unknown. CUDA does not show the spill.

**Not proven:** no machine without NVIDIA or without Vulkan; no real publication (the release upload path ran in dry-run only); the cause of the Vulkan spill. Bugs and requests for the next lot (stop, status, timer, turn trace, reasoning display, `~/.openagent` folders, two old UI bugs) are listed in the `tasks/todo.md` bilan.
