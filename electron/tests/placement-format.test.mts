// The French labels of a placement (hardware and offload, Task 6): where the layers go, and the memory figures,
// always « estimé » (node-llama-cpp's own footprint, never a measurement). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placementLabel, memoryLabel } from '../renderer-src/src/components/model/placement.ts';
import type { Placement } from '../core/placement.mts';

const MIB = 2 ** 20;
const placement = (patch: Partial<Placement>): Placement => ({
  source: 'loaded', backend: 'vulkan', gpuLayers: 63, totalLayers: 63, contextSize: 32768, vramBytes: 0, ramBytes: 0, memoryMeasured: false, fit: 'gpu', ...patch,
});

test('placementLabel: the four fits, « (estimé) » before the load only', () => {
  assert.equal(placementLabel(placement({ fit: 'gpu', source: 'loaded' })), 'tout sur la carte');
  assert.equal(placementLabel(placement({ fit: 'split', gpuLayers: 31, totalLayers: 63, source: 'estimate' })), '31/63 couches sur la carte (estimé)');
  assert.equal(placementLabel(placement({ fit: 'cpu', gpuLayers: 0, backend: 'cpu', source: 'loaded' })), 'processeur seul');
  assert.equal(placementLabel(placement({ fit: 'none', gpuLayers: 0, source: 'estimate' })), 'ne tient pas (estimé)');
});

test('memoryLabel: VRAM and RAM, always « estimé »', () => {
  assert.equal(memoryLabel(placement({ vramBytes: 6_549_000_000, ramBytes: 4_617_000_000 })), 'VRAM 6,1 Gio · RAM 4,3 Gio (estimé)');
  assert.equal(memoryLabel(placement({ vramBytes: 0, ramBytes: 300 * MIB, source: 'estimate' })), 'RAM 300 Mio (estimé)');
});
