// Hardware and offload, Task 2: one node-llama-cpp instance per worker (core/llama-runtime.mts), the hardware it
// reads (core/hardware.mts, op hardware-info), and the two pure helpers the placement display uses.
// Real node-llama-cpp, real worker, real tiny GGUF: no mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { hardwareInfo } from './support/worker-events.mts';
import { readHardware } from '../core/hardware.mts';
import { runtimeLlama, llamaCreated, disposeLlama, runtimeGeneration } from '../core/llama-runtime.mts';
import { engineContextSize, warmModelPath, disposeEngine } from '../core/local-engine.mts';
import { fitOf } from '../core/placement.mts';
import { formatBytes } from '../core/units.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

test('readHardware: backend, RAM from os, CPU cores, GPU fields consistent with the backend', { timeout: 60000 }, async t => {
  t.after(() => disposeLlama());
  const info = await readHardware();
  assert.ok(['cuda', 'vulkan', 'metal', 'cpu'].includes(info.backend), info.backend);
  assert.equal(info.ram.total, os.totalmem());
  assert.ok(info.ram.free > 0 && info.ram.free <= info.ram.total);
  assert.ok(info.cpu.mathCores >= 1);
  assert.equal(info.cpu.logicalCores, os.availableParallelism());
  assert.equal(info.cpu.model, os.cpus()[0].model);
  if (info.backend === 'cpu') {
    assert.equal(info.vram, null);
    assert.equal(info.gpuNames.length, 0);
  } else {
    assert.ok(info.vram && info.vram.total > 0 && info.vram.free <= info.vram.total);
    assert.ok(info.gpuNames.length >= 1);
  }
  assert.equal(info.nvidia, info.gpuNames.some(name => /nvidia/i.test(name)));
  assert.equal(info.notice, null);
});

test('the runtime Llama is created once and shared, and disposeLlama frees it', { timeout: 60000 }, async t => {
  t.after(async () => { await disposeEngine(); await disposeLlama(); });
  const llama = await runtimeLlama();
  assert.equal(await runtimeLlama(), llama);
  assert.equal(llamaCreated(), true);
  // Ruling F3a: disposeLlama frees the warm engine first, then the Llama, then bumps the generation.
  await engineContextSize(modelPath);
  assert.equal(warmModelPath(), modelPath);
  const generation = runtimeGeneration();
  await disposeLlama();
  assert.equal(llamaCreated(), false);
  assert.equal(llama.disposed, true);
  assert.equal(warmModelPath(), null, 'no model or context of the old Llama survives');
  assert.ok(runtimeGeneration() > generation);
  const next = await runtimeLlama();
  assert.notEqual(next, llama, 'a new Llama after dispose');
  assert.equal(runtimeGeneration(), generation + 1, 'creating the next Llama does not bump the generation again');
});

function callWorker(worker: Worker, op: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `hw-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker hardware-info: with NODE_LLAMA_CPP_GPU=false the backend is cpu, with no VRAM and no card', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(os.tmpdir(), 'openagent-hardware-'));
  removeAtEnd(t, home);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home, NODE_LLAMA_CPP_GPU: 'false' },
  });
  terminateAtEnd(t, worker);
  const info = await hardwareInfo(worker);
  assert.equal(info.backend, 'cpu');
  assert.equal(info.vram, null);
  assert.deepEqual(info.gpuNames, []);
  assert.equal(info.nvidia, false);
  assert.equal(info.ram.total, os.totalmem());
  assert.ok(info.cpu.mathCores >= 1);
});

test('fitOf and formatBytes', () => {
  const base = { backend: 'vulkan' as const, gpuLayers: 6, totalLayers: 6, ramBytes: 1, ramTotal: 100, insufficient: false };
  assert.equal(fitOf({ ...base, insufficient: true }), 'none');
  assert.equal(fitOf({ ...base, ramBytes: 101 }), 'none');
  assert.equal(fitOf({ ...base, backend: 'cpu' }), 'cpu');
  assert.equal(fitOf({ ...base, gpuLayers: 0 }), 'cpu');
  assert.equal(fitOf(base), 'gpu');
  assert.equal(fitOf({ ...base, gpuLayers: 31, totalLayers: 63 }), 'split');
  assert.equal(formatBytes(8_342_000_000), '7,8 Gio');
  assert.equal(formatBytes(1_048_576 * 300), '300 Mio');
  assert.equal(formatBytes(1), '1 Mio');
  assert.equal(formatBytes(0), '0 Mio');
});
