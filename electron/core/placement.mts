// Where a local model's layers go (hardware and offload): the shape shown in the app, and the fit it is labelled
// with. Pure, no import: the renderer and the worker read the same rule.
export type Backend = 'cuda' | 'vulkan' | 'metal' | 'cpu';
export type Fit = 'gpu' | 'split' | 'cpu' | 'none';

export interface Placement {
  source: 'estimate' | 'loaded';
  backend: Backend;
  gpuLayers: number;
  totalLayers: number;
  contextSize: number;
  vramBytes: number;
  ramBytes: number;
  /** The byte figures are node-llama-cpp's own estimates, never a measurement. */
  memoryMeasured: false;
  fit: Fit;
}

/** 'none': it does not fit even with 0 layers on the card; 'cpu': nothing on the card; 'gpu': every layer on it;
 * 'split': some on the card, the rest in RAM. */
export function fitOf(input: { backend: Backend; gpuLayers: number; totalLayers: number; ramBytes: number; ramTotal: number; insufficient: boolean }): Fit {
  if (input.insufficient || input.ramBytes > input.ramTotal) return 'none';
  if (input.backend === 'cpu' || input.gpuLayers === 0) return 'cpu';
  if (input.gpuLayers >= input.totalLayers) return 'gpu';
  return 'split';
}
