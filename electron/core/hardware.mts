// What this machine offers a local model: the backend the runtime Llama uses, the card(s) and their VRAM, the
// RAM and the CPU. Free memory is read on every call.
import os from 'node:os';
import { runtimeLlama, backendOf } from './llama-runtime.mts';
import type { Backend } from './placement.mts';

export interface HardwareInfo {
  backend: Backend;
  gpuNames: string[];
  vram: { total: number; free: number } | null;
  ram: { total: number; free: number };
  cpu: { model: string; mathCores: number; logicalCores: number };
  nvidia: boolean;
  notice: string | null;
}

export async function readHardware(): Promise<HardwareInfo> {
  const llama = await runtimeLlama();
  const backend = backendOf(llama);
  let gpuNames: string[] = [];
  let vram: HardwareInfo['vram'] = null;
  if (backend !== 'cpu') {
    // A card the driver cannot describe right now still leaves a usable reading: no names, no VRAM figure.
    const [names, state] = await Promise.all([llama.getGpuDeviceNames().catch(() => []), llama.getVramState().catch(() => null)]);
    gpuNames = names;
    vram = state ? { total: state.total, free: state.free } : null;
  }
  return {
    backend,
    gpuNames,
    vram,
    ram: { total: os.totalmem(), free: os.freemem() },
    cpu: { model: os.cpus()[0]?.model ?? '', mathCores: llama.cpuMathCores, logicalCores: os.availableParallelism() },
    nvidia: gpuNames.some(name => /nvidia/i.test(name)),
    notice: null,
  };
}
