// One node-llama-cpp instance per worker (hardware and offload). Everything that needs the native binding —
// the engine, the hardware reading, the offload estimate — shares this Llama instead of creating its own.
// Created on first use only, never at module load.
//
// The backend (Task 10) is decided once per worker, from what it started with: the user's gpu_backend choice and
// the CUDA pack installed at that moment. Windows keeps a backend's same-named ggml DLLs loaded for the life of the
// process (decision D-CUDA-4), and the pack's runtime folder only reaches the loader through the PATH the main
// process sets before it creates the worker (D-CUDA-2): a later change is applied at the next app start, which
// restartRequired() reports.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { getLlama, getLlamaGpuTypes, Llama, LlamaLogLevel, LlamaLogLevelGreaterThanOrEqual, type LlamaOptions } from 'node-llama-cpp';
import type { Backend } from './placement.mts';
import type { CudaPackStatus } from './cuda-pack.mts';
import { disposeEngine } from './local-engine.mts';

export type GpuBackendChoice = 'auto' | 'cuda' | 'vulkan' | 'cpu';
export const GPU_BACKEND_CHOICES: readonly GpuBackendChoice[] = ['auto', 'cuda', 'vulkan', 'cpu'];
export interface CudaPackSource { installedDir(): Promise<string | null>; status(): Promise<CudaPackStatus> }

let pending: Promise<Llama> | null = null;
let created: Llama | null = null;
// Bumped by every disposeLlama(): whatever was loaded on an older generation belongs to a Llama that is gone,
// and is reloaded rather than reused.
let generation = 0;
let source: CudaPackSource | null = null;
// What this worker started with (setRuntimeStart): the choice, and the pack folder installed at start, if any.
let start: { choice: GpuBackendChoice; packDir: string | null } = { choice: 'auto', packDir: null };
let notice: string | null = null;
// The pack folder the resolve hook points at, once registered (once per thread: hooks cannot be swapped).
let hookedDir: string | null = null;

const label = (backend: Backend) => backend === 'cpu' ? 'le processeur' : backend === 'vulkan' ? 'Vulkan' : backend;

export function cudaFallbackNotice(backend: Backend): string {
  return `Le pack CUDA n'a pas pu se charger : l'app utilise ${label(backend)} à la place.`;
}

export function cudaMismatchNotice(installed: string, expected: string): string {
  return `Le pack CUDA installé (moteur ${installed}) ne correspond plus à cette version de l'app (moteur ${expected}) : l'app utilise Vulkan. Télécharge le pack à jour.`;
}

/** gpu_backend « cuda » without a usable pack. */
export function cudaMissingNotice(backend: Backend): string {
  return `Le moteur CUDA est choisi, mais le pack CUDA n'est pas installé : l'app utilise ${label(backend)} à la place. Installe le pack CUDA puis redémarre l'app.`;
}

/** gpu_backend « vulkan » that could not load. */
export function backendFallbackNotice(wanted: 'vulkan', got: Backend): string {
  return `Le moteur ${label(wanted)} n'a pas pu se charger : l'app utilise ${label(got)} à la place.`;
}

export function setCudaPackSource(next: CudaPackSource | null): void {
  source = next;
}

// TEST SEAM: how long createLlama waits before creating the Llama, standing for a slow first start (the CUDA pack's
// binary test and context creation took more than 30 s on the user's machine). Only a test sets it, through
// workerData.testLlamaDelayMs, which main.cjs never passes (tests/test-seam.test.mts).
let testDelayMs = 0;
export function setTestLlamaDelay(ms: number): void {
  testDelayMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Called once by the worker at start, before any Llama: the user's choice and the pack installed right now. */
export function setRuntimeStart(next: { choice: GpuBackendChoice; packDir: string | null }): void {
  start = { ...next };
}

/** The choice this worker started with. */
export function backendChoice(): GpuBackendChoice {
  return start.choice;
}

/** Why the Llama is not on the backend the user would expect (a pack that failed or is stale), else null. */
export function runtimeNotice(): string | null {
  return notice;
}

const usesPack = (choice: GpuBackendChoice, installed: boolean) => installed && (choice === 'auto' || choice === 'cuda');

/**
 * D-CUDA-4 = restart: true when what is saved now (the pack installed, the gpu_backend choice) would start another
 * backend than the one this worker started with. A Llama need not exist yet: the pack's runtime folder is put on
 * PATH only at app start, so a pack installed since can only be used after a restart.
 */
export function restartRequired(installedDir: string | null, savedChoice: GpuBackendChoice = start.choice): boolean {
  if (savedChoice !== start.choice) return true;
  return usesPack(savedChoice, installedDir !== null) !== usesPack(start.choice, start.packDir !== null);
}

/**
 * D-CUDA-2: the bare specifier `@node-llama-cpp/win-x64-cuda` resolves to the pack's copy (never `-ext`, D-CUDA-3).
 * Only inside a worker thread: never in a main thread, never in the in-process test runner.
 */
function activatePack(dir: string): void {
  if (isMainThread) throw new Error('Le pack CUDA ne se charge que dans le worker.');
  if (hookedDir === dir) return;
  if (hookedDir !== null) throw new Error('Un autre pack CUDA est déjà actif dans ce worker.');
  const entry = pathToFileURL(join(dir, 'node_modules', '@node-llama-cpp', 'win-x64-cuda', 'dist', 'index.js')).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@node-llama-cpp/win-x64-cuda') return { url: entry, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  hookedDir = dir;
}

const GIB = 1024 ** 3;

/**
 * The VRAM padding a Llama of `backend` is created with (I-1): undefined keeps node-llama-cpp's default
 * (min(8 % of the total, 1.6 GiB)). Vulkan on Windows only: ggml-vulkan reads free VRAM from VK_EXT_memory_budget,
 * the WDDM per-process budget, which a probe found about 1 GiB above nvidia-smi (7188 vs 6193 MiB, 2026-10-21) — the
 * default padding was swallowed by that gap, and the driver moved 3.8 GiB of a 27B into shared system memory. The
 * padding is set on the ONE runtime Llama, so the estimate and the load fit layers against the same free VRAM.
 */
export function vramPaddingFor(backend: Backend, platform: NodeJS.Platform = process.platform): ((totalVram: number) => number) | undefined {
  if (backend !== 'vulkan' || platform !== 'win32') return undefined;
  return totalVram => Math.min(Math.floor(totalVram * 0.2), 2.5 * GIB);
}

/**
 * llama.cpp's log, received at « info »: warnings and errors go to node-llama-cpp's own console logger as before;
 * of the info lines, only the buffer sizes (« Vulkan0 / Vulkan_Host / CPU_Mapped model buffer size », KV and compute
 * buffers) reach the app log, prefixed [llama.cpp] — they say where a load really put its bytes. The rest of the
 * info (metadata dumps, one line per tensor) is dropped.
 */
export function llamaLogger(level: LlamaLogLevel, message: string): void {
  if (LlamaLogLevelGreaterThanOrEqual(level, LlamaLogLevel.warn)) {
    Llama.defaultConsoleLogger(level, message);
    return;
  }
  if (/buffer size/.test(message)) console.info(`[llama.cpp] ${message.trim()}`);
}

// Every getLlama passes build: 'never': a missing or broken prebuilt binary never starts a download or a compilation.
// `target` is the backend the call aims at, for its VRAM padding (vramPaddingFor); a processor result ignores it.
function llamaWith(options: Omit<LlamaOptions, 'build' | 'vramPadding' | 'logLevel' | 'logger'>, target: Backend): Promise<Llama> {
  const vramPadding = vramPaddingFor(target);
  return getLlama({ ...options, build: 'never', logLevel: LlamaLogLevel.info, logger: llamaLogger, ...(vramPadding ? { vramPadding } : {}) });
}
// Without CUDA, a GPU Llama on Windows can only be Vulkan (or the processor, which has no padding).
const withoutCuda = () => llamaWith({ gpu: { type: 'auto', exclude: ['cuda'] } }, 'vulkan');
// A load error is never shown raw to the user (the French notice says what happened), but it is logged: the manual
// CUDA check reads it there.
function warn(what: string, error: unknown): void {
  console.warn(`[gpu-backend] ${what} : ${(error as Error | undefined)?.message ?? error}`);
}

async function createLlama(): Promise<{ llama: Llama; notice: string | null }> {
  if (testDelayMs > 0) await new Promise(resolve => setTimeout(resolve, testDelayMs));
  const { choice } = start;
  if (choice === 'cpu') return { llama: await llamaWith({ gpu: false }, 'cpu'), notice: null };
  if (choice === 'vulkan') {
    try {
      return { llama: await llamaWith({ gpu: 'vulkan' }, 'vulkan'), notice: null };
    } catch (error) {
      warn('Vulkan ne se charge pas', error);
      const llama = await llamaWith({ gpu: false }, 'cpu');
      return { llama, notice: backendFallbackNotice('vulkan', backendOf(llama)) };
    }
  }
  // auto or cuda: the pack installed at start, if it is still this app's own valid pack.
  const status = source ? await source.status().catch(error => { warn('état du pack CUDA illisible', error); return null; }) : null;
  if (status?.state === 'mismatch') {
    // A stale pack is never activated, and no other CUDA build stands in for it.
    return { llama: await withoutCuda(), notice: cudaMismatchNotice(status.installedVersion ?? '?', status.expectedVersion) };
  }
  const dir = start.packDir !== null && source ? await source.installedDir().catch(error => { warn('dossier du pack CUDA illisible', error); return null; }) : null;
  if (dir !== null && dir === start.packDir) {
    try {
      activatePack(dir);
      return { llama: await llamaWith({ gpu: 'cuda' }, 'cuda'), notice: null };
    } catch (error) {
      warn('le pack CUDA ne se charge pas', error);
      const llama = await withoutCuda();
      return { llama, notice: cudaFallbackNotice(backendOf(llama)) };
    }
  }
  if (choice === 'cuda') {
    const llama = await withoutCuda();
    return { llama, notice: cudaMissingNotice(backendOf(llama)) };
  }
  return { llama: await autoLlama(), notice: null };
}

/**
 * NODE_LLAMA_CPP_GPU as node-llama-cpp reads it (bindings/types.js parseNodeLlamaCppGpuOption, 3.21.1): unset,
 * « auto » or an unknown value is 'auto'; « false », « off », « none », « disable », « disabled » the processor.
 */
export function envGpuChoice(value: string | undefined): Backend | 'auto' {
  if (value === undefined || value === '') return 'auto';
  if (['false', 'off', 'none', 'disable', 'disabled'].includes(value)) return 'cpu';
  return value === 'cuda' || value === 'vulkan' || value === 'metal' ? value : 'auto';
}

/**
 * « auto » without a pack, resolved here one backend at a time instead of by getLlama's own auto, so the Llama is
 * created with the padding of the backend it really is: a padding is fixed at creation and its function only sees
 * the total VRAM. Same order as node-llama-cpp's auto (getLlama → getGpuTypesToUseForOption('auto'), which is
 * getLlamaGpuTypes('supported')): CUDA when its driver and runtime are found, then Vulkan, then the processor.
 * A NODE_LLAMA_CPP_GPU other than auto is node-llama-cpp's choice, passed through.
 */
async function autoLlama(): Promise<Llama> {
  const forced = envGpuChoice(process.env.NODE_LLAMA_CPP_GPU);
  if (forced !== 'auto') return llamaWith({}, forced);
  if ((await getLlamaGpuTypes('supported')).includes('cuda')) {
    try {
      return await llamaWith({ gpu: 'cuda' }, 'cuda');
    } catch (error) {
      warn('CUDA (auto) ne se charge pas', error);
    }
  }
  return withoutCuda();
}

/** The worker's Llama, created once (see createLlama for the backend). A rejected creation is not cached: the next
 * call tries again. */
export async function runtimeLlama(): Promise<Llama> {
  if (!pending) {
    const attempt = createLlama().then(result => {
      if (pending === attempt) notice = result.notice;
      return result.llama;
    });
    pending = attempt;
    attempt.then(llama => { if (pending === attempt) created = llama; }, () => { if (pending === attempt) pending = null; });
  }
  return pending;
}

export function llamaCreated(): boolean {
  return created !== null;
}

/** The current runtime generation: it changes each time the Llama is disposed. */
export function runtimeGeneration(): number {
  return generation;
}

/** Frees the warm engine (its model and context) first, then the Llama, then bumps the generation. */
export async function disposeLlama(): Promise<void> {
  await disposeEngine();
  const attempt = pending;
  pending = null;
  created = null;
  if (attempt) {
    const llama = await attempt.catch(() => null);
    if (llama && !llama.disposed) await llama.dispose();
  }
  generation += 1;
}

export function backendOf(llama: Llama): Backend {
  return llama.gpu === false ? 'cpu' : llama.gpu;
}
