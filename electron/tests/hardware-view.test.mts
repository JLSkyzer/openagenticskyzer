// The « Matériel » settings tab's French lines and its context choices (hardware and offload, Task 7). Pure.
// The machine values below are test inputs, not measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareLines, LOCAL_CONTEXT_OPTIONS, maxTokensSliderMax } from '../renderer-src/src/components/settings/hardware-view.ts';
// What op hardware-info answers: core/hardware.mts::HardwareInfo plus the worker's backendChoice and restartRequired.
import type { HardwareInfo } from '../renderer-src/src/ipc/types.ts';

const card: HardwareInfo = {
  backend: 'vulkan',
  gpuNames: ['NVIDIA GeForce RTX 4060'],
  vram: { total: 8_342_000_000, free: 6_549_000_000 },
  ram: { total: 34_270_000_000, free: 19_540_000_000 },
  cpu: { model: 'AMD Ryzen 7 5800X 8-Core Processor', mathCores: 8, logicalCores: 16 },
  nvidia: true,
  notice: null,
  backendChoice: 'auto',
  restartRequired: false,
};

test('hardwareLines in French for a card and for the processor alone; the context choices', () => {
  assert.deepEqual(hardwareLines(card), [
    { field: 'backend', text: 'Moteur : Vulkan' },
    { field: 'gpu', text: 'Carte : NVIDIA GeForce RTX 4060' },
    { field: 'vram', text: 'VRAM : 7,8 Gio au total, 6,1 Gio libres' },
    { field: 'ram', text: 'RAM : 31,9 Gio au total, 18,2 Gio libres' },
    { field: 'cpu', text: 'Processeur : AMD Ryzen 7 5800X 8-Core Processor — 8 cœurs de calcul' },
  ]);

  const cpuOnly = hardwareLines({ ...card, backend: 'cpu', gpuNames: [], vram: null });
  assert.deepEqual(cpuOnly.map(line => line.field), ['backend', 'gpu', 'ram', 'cpu'], 'no VRAM line without a card');
  assert.equal(cpuOnly[0].text, 'Moteur : processeur seul');
  assert.equal(cpuOnly[1].text, 'Carte : aucune utilisée');

  const notice = 'Pack CUDA absent : moteur Vulkan utilisé.';
  const withNotice = hardwareLines({ ...card, notice });
  assert.deepEqual(withNotice[withNotice.length - 1], { field: 'notice', text: notice }, 'the notice comes last');
  assert.equal(hardwareLines({ ...card, backend: 'cuda', gpuNames: ['A', 'B'] })[1].text, 'Carte : A + B');

  assert.deepEqual(LOCAL_CONTEXT_OPTIONS, [
    { value: 16384, label: '16k' },
    { value: 32768, label: '32k (défaut)' },
    { value: 65536, label: '64k' },
    { value: 131072, label: '128k' },
    { value: 'max', label: 'max du modèle' },
  ]);

  // Ruling F6: the max_tokens slider follows the « Contexte des modèles locaux » setting, never the engine's
  // window — max_tokens stays a cap on the request window only.
  assert.equal(maxTokensSliderMax({ hasModel: false, setting: 131072 }), 16384, 'no model: the floor');
  assert.equal(maxTokensSliderMax({ hasModel: true, setting: 65536 }), 65536);
  assert.equal(maxTokensSliderMax({ hasModel: true, setting: 'max' }), 131072, "'max': the largest fixed choice");
});
