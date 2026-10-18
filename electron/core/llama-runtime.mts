// One node-llama-cpp instance per worker (hardware and offload). Everything that needs the native binding —
// the engine, the hardware reading, the offload estimate — shares this Llama instead of creating its own.
// Created on first use only, never at module load.
import { getLlama, type Llama } from 'node-llama-cpp';
import type { Backend } from './placement.mts';
import { disposeEngine } from './local-engine.mts';

let pending: Promise<Llama> | null = null;
let created: Llama | null = null;
// Bumped by every disposeLlama(): whatever was loaded on an older generation belongs to a Llama that is gone,
// and is reloaded rather than reused.
let generation = 0;

/** The worker's Llama, created once. `build: 'never'`: a missing or broken prebuilt binary must never start a
 * llama.cpp download or compilation. No `gpu` option: node-llama-cpp reads NODE_LLAMA_CPP_GPU (default auto).
 * A rejected creation is not cached: the next call tries again. */
export async function runtimeLlama(): Promise<Llama> {
  if (!pending) {
    const attempt = getLlama({ build: 'never' });
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
