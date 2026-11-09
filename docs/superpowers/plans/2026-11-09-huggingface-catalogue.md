# Catalogue Hugging Face — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A catalogue inside the model dialog that recommends, scores /5, downloads, verifies and activates a `.gguf` model for this machine, with a configurable models folder and a per-project model choice.

**Architecture:** Pure core modules (Hugging Face parsing, tool detection, scoring), one download manager persisted in the data home, all driven by new worker ops and one `catalogue-download` event; a React section in `ModelDialog`. The per-project choice lives in the data home, never in the project.

**Tech Stack:** Electron 44, worker_thread `worker.mjs`, `.mts` via `--experimental-strip-types`, node-llama-cpp 3.21.1, React 19.

**Spec:** `docs/superpowers/specs/2026-11-09-huggingface-catalogue-design.md`

## Global Constraints

- `.gguf` local models only; Hugging Face is catalogue and download source; no other source; no download without a user click.
- No tool or setting removed; manual `.gguf` import stays.
- UI text in French. Public repo: no personal paths.
- `hf_token` is sent only to `huggingface.co` and never logged. It must never follow a redirect to another host.
- Automated tests never touch the real network: the fake server `tests/support/fake-hf.mts`, reached through the seam `workerData.hfBaseUrl` (same rule as `cudaPackBaseUrl`: never honoured when packaged). Temp homes (`OPENAGENT_HOME`) only.
- New test files are imported in `tests/all.mts`. Baseline before Task 1: 1136 tests, core tsc 4 errors, renderer tsc 0.
- Window tests are edited in their task and run ONCE at closure. The full suite runs alone, once per task, from `electron/`, behind `node --experimental-strip-types bench/guard.mts &&`, without a `timeout` under 900 s.
- Edit only with Edit/Write. LF. Stage explicit paths. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, then push to `origin master`.
- Text from a repository (names, templates, file names) is untrusted data: never rendered as HTML, never used in a path without `safeModelFileName`.
- Never present an estimated figure as measured: the score is labelled « estimée ».

## Review Focus

1. A redirect from `huggingface.co` to a CDN host: the `Authorization` header is dropped. Pinned in Task 4.
2. The disk fills up during a download (`ENOSPC`): the job ends in `error` with a French message, the app stays usable, nothing is activated. Pinned in Task 4.
3. An install finishes while a turn is running: the turn keeps its model, the new one applies at the next send. Pinned in Task 5.
4. On restart the models folder of a pending job is gone (unplugged drive): the job goes to `error`, nothing is recreated elsewhere. Pinned in Task 4.
5. A malformed or partial Hugging Face answer (missing `gguf`, non-array, an entry without `path`): the catalogue shows what it can, or the French error, and never throws out of the op. Pinned in Task 2.

---

### Task 1: What « sait appeler des outils » means — the probe, then the rule

**Files:** Create `core/model-capabilities.mts`, `tests/model-capabilities.test.mts`, `tests/fixtures/chat-templates.json`.

**Interfaces:** Produces `export type ToolSupport = 'yes' | 'no' | 'unknown'` and `export function toolSupportOf(chatTemplate: string | undefined | null): ToolSupport`. No model load, no network.

- [ ] **Step 1: The probe (throwaway).** In a script outside the repo, call node-llama-cpp's `resolveChatWrapper` (see `bench/tool-tokens.mts` for how it is used without a context) on at least: the 27B's template (`GGUF` header of `D:\Models\Qwen3.8-27B-abliterated-mtp-IQ3_M.gguf`, read-only, `readGgufFileInfo`), and four public templates taken from `GET /api/models?filter=gguf&expand[]=gguf` of different families, one of them with no tool mention (a plain story or Gemma-like chat template). For each record the wrapper chosen, its `settings.functions`, and whether a rendered history with a function contains the function. Record the table and your rule in the task report.
- [ ] **Step 2: Fix the rule from the probe.** Rule shape required: a template node-llama-cpp can render tools with → `yes`; one it demonstrably cannot → `no`; missing, empty, or a resolution that throws → `unknown`. Save the probed templates as fixtures.
- [ ] **Step 3: Failing tests** `toolSupportOf` on each fixture with its probed value; `toolSupportOf(undefined)` and `''` → `unknown`; a template that makes resolution throw → `unknown`, not a throw.
- [ ] **Step 4: Implement, run focused tests, full suite, core tsc. Commit** `feat: decide from node-llama-cpp itself whether a model's chat template can call tools`.

### Task 2: The Hugging Face client

**Files:** Create `core/hf-catalogue.mts`, `tests/hf-catalogue.test.mts`, `tests/support/fake-hf.mts`.

**Interfaces — Produces:**
```ts
export interface CatalogueModel { id: string; downloads: number; likes: number; gated: boolean; lastModified: string; architecture: string | null; contextLength: number | null; chatTemplate: string | null; tags: string[] }
export interface ModelVariant { name: string; files: { path: string; size: number; sha256: string | null }[]; totalBytes: number }
export const HF_BASE_URL = 'https://huggingface.co';
export type CatalogueSort = 'downloads' | 'likes' | 'lastModified';
export function searchModels(options: { query?: string; sort?: CatalogueSort; limit?: number; baseUrl?: string; token?: string; signal?: AbortSignal }): Promise<CatalogueModel[]>;
export function modelVariants(id: string, options: { baseUrl?: string; token?: string; signal?: AbortSignal }): Promise<ModelVariant[]>;
export function groupVariants(entries: unknown): ModelVariant[];
export function safeModelFileName(path: string): string; // the file's base name; throws 'Nom de fichier refusé' on an empty name, `..`, a separator after normalising, a reserved Windows name, or anything not ending in .gguf
export class HfError extends Error { kind: 'offline' | 'gated' | 'bad-answer' }
```
`tests/support/fake-hf.mts` produces `startFakeHf(): Promise<{ baseUrl, setFile(path, bytes, opts), setModels(list), hits, close }>` serving the three endpoints of the spec, with options for range support, a mid-stream cut, a 401/403, and a 307 to a second port.

- [ ] **Step 1: Failing tests:** the listing URL carries `filter=gguf` and the five `expand[]`; `gguf.total` is never used as a size (sizes come from the tree: `gguf.total` is unverified); `groupVariants` makes one variant of `x-00001-of-00003.gguf` … `x-00003-of-00003.gguf` with summed size and three hashes, sorted by part; excludes any path containing `mmproj`; a non-LFS `.gguf` gets `sha256: null`; `safeModelFileName('../../evil.gguf')` and `'CON.gguf'` throw; 401 and 403 → `HfError` kind `gated`; a fetch failure → `offline`; **Review Focus 5:** a non-array, an entry without `path` and a model without `gguf` give a partial result or `bad-answer`, never a `TypeError`.
- [ ] **Step 2: Run, watch them fail. Step 3: Implement** with global `fetch`, a 20 s timeout per call, `User-Agent: openagent`, `Authorization` only when the URL's host is `huggingface.co` or the test seam's. **Step 4: Focused, full, tsc. Commit** `feat: read the Hugging Face catalogue — models, their .gguf variants and hashes`.

### Task 3: The score

**Files:** Create `core/code-families.mts`, `core/model-score.mts`, `tests/model-score.test.mts`.

**Interfaces — Consumes:** `ToolSupport`, `CatalogueModel`, `ModelVariant`, `HardwareInfo` (`core/hardware.mts`). **Produces:**
```ts
export type Fit = 'full' | 'partial' | 'slow' | 'none';
export type CodeQuality = 'strong' | 'good' | 'unknown';
export const VRAM_RESERVE_BYTES: number; export const RAM_RESERVE_BYTES: number;
export function fitOf(variant: ModelVariant, hardware: HardwareInfo, contextSize: number): Fit;
export function chooseVariant(variants: ModelVariant[], hardware: HardwareInfo, contextSize: number): ModelVariant | null;
export function codeQualityOf(model: Pick<CatalogueModel, 'id' | 'architecture'>): CodeQuality;
export interface ModelScore { stars: number; fit: Fit; tools: ToolSupport; code: CodeQuality; estimated: true; sentence: string }
export function scoreModel(input: { fit: Fit; tools: ToolSupport; code: CodeQuality }): ModelScore;
export interface RecommendationInput { model: CatalogueModel; variant: ModelVariant | null; score: ModelScore }
export type Recommendation = { kind: 'install'; item: RecommendationInput } | { kind: 'try'; item: RecommendationInput } | { kind: 'none'; reason: 'no-fit' | 'offline' | 'gated-only' };
export function recommend(items: RecommendationInput[]): Recommendation;
```

Values pinned: stars = fit (`full` 2, `partial` 1.5, `slow` 1, `none` total 0) + tools (`yes` 1.5, `unknown` 0.75, `no` 0) + code (`strong` 1.5, `good` 1, `unknown` 0.5), rounded down to 0.5, then capped: tools `no` ≤ 2; code `unknown` ≤ 3.5; tools `unknown` ≤ 3. `fitOf`: `full` when the file plus context cost fits in `vram.total − VRAM_RESERVE_BYTES`; `none` when the file plus context cost does not fit in VRAM + RAM minus both reserves; otherwise `partial` when the card holds at least a quarter of the file, else `slow`; no card: `slow` or `none`. The reserves and the context cost per token are named constants, calibrated from `placement` in `.superpowers/bench/20261109-205459-27b-final.json`, and the calibration is written beside them. `chooseVariant`: the largest variant with every hash present whose fit is `full`; else the largest `partial`; else the largest `slow`; else null. Size order stands for quantification order. `recommend`: eligible = not gated, variant non-null, fit ≠ `none`, tools `yes` → `install`, best stars, ties on downloads. Else the best with tools `unknown` → `try`. Else `none`.

`code-families.mts`: `CODE_FAMILIES: { match: RegExp; quality: 'strong' | 'good'; source: string; checkedOn: string }[]`, the families in common use for code. Each entry cites a URL the implementer actually read, dated. Fewer entries beat an invented one. A modified build (`abliterated`, `uncensored`) matches its base family and is neither boosted nor hidden.

- [ ] **Step 1: Failing tests, named cases:** 27B-size (12.8 GB) on 8 GB VRAM and 32 GB RAM → `partial`; 30 GB on 8 GB VRAM and 16 GB RAM → `none`; 4 GB on 8 GB VRAM → `full`; no card, 4 GB, 32 GB RAM → `slow`; `{full, yes, strong}` → 5; `{full, yes, unknown}` → 3.5; `{full, no, strong}` → 2; `{full, unknown, strong}` → 3; `{none, yes, strong}` → 0; `chooseVariant` skips a larger variant with a null hash; `recommend` never returns a `none`-fit, gated or null-variant item; only tools-unknown candidates → `try`; empty list → `none`; a score's `sentence` is French, contains no number of tok/s, and names an unknown axis in words.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Focused, full, tsc. Commit** `feat: score a model /5 for this machine, with what is unknown said as unknown`.

### Task 4: The download manager

**Files:** Create `core/model-download.mts`, `core/sha256-file-worker.mjs`, `tests/model-download.test.mts`.

**Interfaces — Consumes:** `ModelVariant`, `safeModelFileName`, `startFakeHf`. **Produces:**
```ts
export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
export interface DownloadJob { id: string; repo: string; variantName: string; dir: string; files: ModelVariant['files']; state: DownloadState; receivedBytes: number; totalBytes: number; bytesPerSecond: number | null; error: string | null; finalPath: string | null }
export const MODEL_DISK_MARGIN_BYTES = 1_073_741_824;
export const NOT_ENOUGH_DISK: string; export const HASH_MISMATCH: string;
export class ModelDownloads {
  constructor(options: { home: string; baseUrl?: string; token?: () => Promise<string | undefined>; onChange(job: DownloadJob): void; onDone(job: DownloadJob): Promise<void> });
  resume(): Promise<void>;
  add(repo: string, variant: ModelVariant, dir: string): Promise<DownloadJob>;
  cancel(id: string): Promise<void>;
  list(): DownloadJob[];
  close(): Promise<void>;
}
export function sha256File(path: string, signal?: AbortSignal): Promise<string>;
```
Persisted in `<home>/model-downloads.json` through `JsonStore`. One job at a time, FIFO. `<dir>/<file>.part`, resumed with `Range` when its size is below the expected one; a change of expected `size` or `lfs.oid` in the job restarts it at zero; a `.part` larger than expected restarts at zero; a server that answers 200 to a `Range` restarts at zero. `sha256File` runs in a `node:worker_threads` worker on `sha256-file-worker.mjs`. Rename `.part` to its final name only after its hash matches; `finalPath` is the first file. Progress `onChange` at most 4 times a second. Redirects are followed by hand, up to 5, https only outside the seam, `Authorization` removed as soon as the host is not `huggingface.co`.

- [ ] **Step 1: Failing tests:** full download of a two-part variant; **Review Focus 1:** 307 to a second port, the second request has no `Authorization`; cut mid-stream then automatic retry resumes with the right `Range` and the file is byte-exact; `close()` during a download then a new `ModelDownloads` + `resume()` finishes it; a wrong hash → state `error`, `HASH_MISMATCH`, no final file, `onDone` not called; free space below `totalBytes + MODEL_DISK_MARGIN_BYTES` → `NOT_ENOUGH_DISK` before any request; **Review Focus 2:** an injected write failure with code `ENOSPC` → `error` in French, next job still starts; **Review Focus 4:** a pending job whose `dir` is gone → `error` on `resume()`, directory not recreated; cancel removes the `.part` and starts the next; a second `add` queues; a 200 answer to a `Range` restarts.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Focused, full, tsc, confirm `core/sha256-file-worker.mjs` is matched by `build.files` (`core/**/*`). Commit** `feat: download a model with resume, verification and a queue that survives a restart`.

### Task 5: Worker ops, settings, activation

**Files:** Modify `core/settings.mts`, `core/gguf-library.mts`, `worker.mjs`, `main.cjs` (`allowed`, `workerData.hfBaseUrl`), `renderer-src/src/ipc/bridge.ts`. Create `core/catalogue-service.mts`, `tests/worker-catalogue.test.mts`.

**Interfaces — Produces:**
- Setting `models_dir: ''` (`''`: `<home>/models`), validated as `''` or an absolute path.
- `GgufLibrary.add(path, options?: { sizeBytes?: number })`: `sizeBytes` overrides the first part's size for a split model.
- `core/catalogue-service.mts`: `class CatalogueService { constructor(deps); list(options: { query?: string; sort?: CatalogueSort }): Promise<CatalogueView>; }` with `CatalogueView = { recommendation: Recommendation; items: RecommendationInput[]; error: 'offline' | null }`. Variants are fetched for the top 20 models only, 4 at a time, and the listing is cached in memory for 1 hour per query and sort.
- Ops `catalogue-list {query, sort}`, `catalogue-variants {repo}`, `catalogue-install {repo, variantName, activate}`, `catalogue-cancel {id}`, `catalogue-downloads`, added to `ops` (worker) and `allowed` (main). Event `{ type:'event', event:'catalogue-download', job }`. Bridge functions of the same names.

`onDone` adds the file to the library and, when `activate` was asked, sets `active_local_model` in global settings. `ModelDownloads.resume()` runs at worker start; `close()` is awaited in the quit path inside its existing bound.

- [ ] **Step 1: Failing tests** through the real worker with the fake server: `catalogue-list` shape; offline → `error: 'offline'` and no throw; `catalogue-install` with `activate` ends with the library entry and `active_local_model` set; an invalid hash leaves `active_local_model` unchanged; `models_dir` is honoured and its change leaves the existing library entry; **Review Focus 3:** install completing during a turn: the turn's `model` event names the old model, the next send the new one; a packaged worker ignores `hfBaseUrl` (assert in the same style as the cuda seam test).
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Focused, full, tsc core and renderer. Commit** `feat: install a model from the catalogue through the worker, and a configurable models folder`.

### Task 6: A model per project

**Files:** Create `core/project-models.mts`, `tests/project-models.test.mts`. Modify `core/active-model.mts`, `worker.mjs` (`turnProvider`, compaction, `estimateModel`'s fallback), `main.cjs`, `renderer-src/src/ipc/bridge.ts`.

**Interfaces — Produces:** `class ProjectModels { constructor(home: string); get(folder: string): Promise<string | null>; set(folder: string, modelId: string | null): Promise<void> }`, keyed by the same canonical path as `FoldersService`, stored in `<home>/project-models.json`. `activeModel(settings, library, folder?)` returns `{ ...entry, fallback: boolean }`, where `fallback` means the project's model is gone and the default answered. Ops `project-model-get {folder}`, `project-model-set {folder, modelId}`. The `model` event gains `fallback: true` when so, with the notice « Le modèle de ce projet est introuvable : modèle par défaut utilisé. »

- [ ] **Step 1: Failing tests:** no choice → the global model; a choice → that model's path in `turnProvider`; its file gone → default and `fallback: true`; nothing is written under the project folder (assert `.openagent/` unchanged); a `.openagent/config.json` holding `active_local_model` or `project_model` has no effect; a turn in project A keeps its model when project B's choice changes.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Focused, full, tsc. Commit** `feat: choose a model per project, kept in the user's data and never in the project`.

### Task 7: The interface

**Files:** Create `renderer-src/src/components/model/CatalogueSection.tsx`, `renderer-src/src/components/model/catalogue-view.ts`, `tests/catalogue-visual.cjs`, `tests/run-catalogue-visual.cjs`, `tests/catalogue-view.test.mts`. Modify `ModelDialog.tsx`, `HardwareTab.tsx`, `FolderTab.tsx`, `package.json` (script `test:catalogue` only).

**Interfaces — Consumes:** the bridge functions of Tasks 5 and 6. **Produces:** `catalogue-view.ts` pure helpers `formatScore(score)`, `formatEta(job)`, `recommendationText(rec)`, tested without a window.

Screen: top card (name, « 4,5/5 (estimée) », `sentence`, button **Installer et utiliser**); `try` shows « À essayer » without the one-click button; `none` shows its French message and no button. Below: search, sort (Note, Téléchargements, Récents), the list with stars, size, and « Accès restreint » for gated models. A model's detail lists its variants, with the chosen one marked. A download shows progress, speed, remaining time and **Annuler**. `HardwareTab`: « Dossier des modèles » with the native picker. `FolderTab`: « Modèle de ce projet », `Par défaut` or a library model. Names and repository texts are rendered as text nodes only.

- [ ] **Step 1: Failing tests** in `catalogue-view.test.mts` for the three helpers, `recommendationText` for each `Recommendation` kind and reason.
- [ ] **Step 2: Implement; focused, full, both tsc, `npm run renderer:build`.**
- [ ] **Step 3: Write `tests/catalogue-visual.cjs`** (edited, not run: `node --check`): with the fake server, the card appears, install shows progress, ends active in the model dialog, a project selector saves, a `try` and a `none` state each shown. Each `waitFor` must be false on the initial state.
- [ ] **Step 4: Commit** `feat: the catalogue screen — a recommendation, a searchable list and the download's progress`.

### Task 8: Closure

- [ ] Ask the user before heavy runs. Full suite alone; `tsc` core and renderer; `renderer:build`; `tests/updater.test.mts`.
- [ ] Window tests ONCE each, failures reported and not re-run: `test:catalogue`, `test:localmodel`, `test:model`, `test:hardware`, `test:settings-tabs`.
- [ ] `package:win` once, `test:package`; `release/win-unpacked/resources/app.asar` holds `core/model-download.mts`, `core/sha256-file-worker.mjs`, `core/code-families.mts`, no `bench/`, no `tests/`.
- [ ] With the user, once, real network: a small real tool-capable model downloaded from the catalogue, verified, activated, then a turn that calls a tool. Without the user: write « non vérifié en réel ».
- [ ] Bilan in `tasks/todo.md`, lessons, a README line under the features, proposals for `D:\BDC`, final whole-branch review.
