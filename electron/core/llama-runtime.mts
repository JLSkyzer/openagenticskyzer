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
import { getLlama, type Llama, type LlamaOptions } from 'node-llama-cpp';
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

// Every getLlama passes build: 'never': a missing or broken prebuilt binary never starts a download or a compilation.
const llamaWith = (options: Omit<LlamaOptions, 'build'>) => getLlama({ ...options, build: 'never' });
const withoutCuda = () => llamaWith({ gpu: { type: 'auto', exclude: ['cuda'] } });

async function createLlama(): Promise<{ llama: Llama; notice: string | null }> {
  const { choice } = start;
  if (choice === 'cpu') return { llama: await llamaWith({ gpu: false }), notice: null };
  if (choice === 'vulkan') {
    try {
      return { llama: await llamaWith({ gpu: 'vulkan' }), notice: null };
    } catch {
      const llama = await llamaWith({ gpu: false });
      return { llama, notice: backendFallbackNotice('vulkan', backendOf(llama)) };
    }
  }
  // auto or cuda: the pack installed at start, if it is still this app's own valid pack.
  const status = source ? await source.status().catch(() => null) : null;
  if (status?.state === 'mismatch') {
    // A stale pack is never activated, and no other CUDA build stands in for it.
    return { llama: await withoutCuda(), notice: cudaMismatchNotice(status.installedVersion ?? '?', status.expectedVersion) };
  }
  const dir = start.packDir !== null && source ? await source.installedDir().catch(() => null) : null;
  if (dir !== null && dir === start.packDir) {
    try {
      activatePack(dir);
      return { llama: await llamaWith({ gpu: 'cuda' }), notice: null };
    } catch {
      const llama = await withoutCuda();
      return { llama, notice: cudaFallbackNotice(backendOf(llama)) };
    }
  }
  if (choice === 'cuda') {
    const llama = await withoutCuda();
    return { llama, notice: cudaMissingNotice(backendOf(llama)) };
  }
  // No gpu option: node-llama-cpp reads NODE_LLAMA_CPP_GPU (default auto).
  return { llama: await getLlama({ build: 'never' }), notice: null };
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
