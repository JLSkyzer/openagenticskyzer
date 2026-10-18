// The French labels of a model's placement (core/placement.mts). Pure. Before a load the layers are node-llama-cpp's
// estimate, marked « (estimé) »; after it they are model.gpuLayers, the truth. The memory figures are always
// node-llama-cpp's assumed footprint (memoryMeasured is false), so they always say « estimé ».
import { formatBytes } from '../../../../core/units.mts';
import type { Placement } from '../../ipc/types';

export function placementLabel(p: Placement): string {
  const label = p.fit === 'gpu' ? 'tout sur la carte'
    : p.fit === 'split' ? `${p.gpuLayers}/${p.totalLayers} couches sur la carte`
      : p.fit === 'cpu' ? 'processeur seul'
        : 'ne tient pas';
  return p.source === 'estimate' ? `${label} (estimé)` : label;
}

export function memoryLabel(p: Placement): string {
  const ram = `RAM ${formatBytes(p.ramBytes)}`;
  return p.vramBytes > 0 ? `VRAM ${formatBytes(p.vramBytes)} · ${ram} (estimé)` : `${ram} (estimé)`;
}
