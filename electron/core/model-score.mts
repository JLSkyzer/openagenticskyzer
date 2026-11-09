// The /5 score of a model for THIS machine, and which model is recommended. Everything here is an estimate from
// file size, tool-calling support and code reputation: never presented as measured, and what is unknown is said
// as unknown. Speed is never claimed.
import type { ToolSupport } from './model-capabilities.mts';
import type { CatalogueModel, ModelVariant } from './hf-catalogue.mts';
import type { HardwareInfo } from './hardware.mts';
import { CODE_FAMILIES } from './code-families.mts';

export type Fit = 'full' | 'partial' | 'slow' | 'none';
export type CodeQuality = 'strong' | 'good' | 'unknown';

// Calibration. MEASURED ON ONE MODEL AND ONE MACHINE (Qwen3.8-27B IQ3_M, 12 768 331 360 bytes, RTX card of 8 GB,
// 34.3 GB of RAM, context 32768; .superpowers/bench/20261109-205459-27b-final.json, placement): the runtime put
// 25 of 66 layers on the card, vramBytes 6 343 752 960 and ramBytes 9 125 190 560.
//   - Memory used beyond the file: 6 343 752 960 + 9 125 190 560 − 12 768 331 360 = 2 700 612 160 bytes for 32768
//     tokens, i.e. 82 421 bytes per context token. This lumps the KV cache and the compute buffers together.
//     That figure is measured for this one model only. ASSUMPTIONS made on top of it, to err toward a lower note:
//     the KV cache grows with layer count and KV heads, which grow with the model, so the cost is scaled up
//     proportionally to the file size above the 27B's size (never scaled down: a small model may have a heavy
//     cache), and a 25 % margin is added. Neither the proportionality nor the margin has been measured.
//   - VRAM reserve: the run left roughly 1.6 GB of the card unused; 1.5 GB is kept back for the display and the
//     driver. The unused share is observed, the choice of 1.5 GB is a judgement.
//   - RAM reserve: NOT measured (the run says nothing about what the system needs); 4 GB is an assumption for
//     Windows and the other open applications.
export const VRAM_RESERVE_BYTES = 1_500_000_000;
export const RAM_RESERVE_BYTES = 4_000_000_000;
export const MEASURED_CONTEXT_BYTES_PER_TOKEN = 82_421;
export const MEASURED_MODEL_BYTES = 12_768_331_360;
export const CONTEXT_COST_MARGIN = 1.25;

/** Estimated memory for the context of a model file: measured on the 27B, scaled up (never down) with size, plus a margin. */
export function contextCostBytes(fileBytes: number, contextSize: number): number {
  const scale = Math.max(1, fileBytes / MEASURED_MODEL_BYTES);
  return Math.ceil(contextSize * MEASURED_CONTEXT_BYTES_PER_TOKEN * scale * CONTEXT_COST_MARGIN);
}

export function fitOf(variant: ModelVariant, hardware: HardwareInfo, contextSize: number): Fit {
  const need = variant.totalBytes + contextCostBytes(variant.totalBytes, contextSize);
  const card = hardware.vram ? Math.max(0, hardware.vram.total - VRAM_RESERVE_BYTES) : 0;
  const ram = Math.max(0, hardware.ram.total - RAM_RESERVE_BYTES);
  if (need <= card) return 'full';
  if (need > card + ram) return 'none';
  if (hardware.vram && card >= variant.totalBytes / 4) return 'partial';
  return 'slow';
}

const hashed = (variant: ModelVariant) => variant.files.length > 0 && variant.files.every((file) => !!file.sha256);

/** Size order stands for quantisation order: the largest variant of the best fit that has every hash. */
export function chooseVariant(variants: ModelVariant[], hardware: HardwareInfo, contextSize: number): ModelVariant | null {
  const bySizeDesc = variants.filter(hashed).sort((a, b) => b.totalBytes - a.totalBytes);
  for (const wanted of ['full', 'partial', 'slow'] as Fit[]) {
    const found = bySizeDesc.find((variant) => fitOf(variant, hardware, contextSize) === wanted);
    if (found) return found;
  }
  return null;
}

export function codeQualityOf(model: Pick<CatalogueModel, 'id' | 'architecture'>): CodeQuality {
  for (const family of CODE_FAMILIES) if (family.match.test(model.id)) return family.quality;
  return 'unknown';
}

export interface ModelScore { stars: number; fit: Fit; tools: ToolSupport; code: CodeQuality; estimated: true; sentence: string }

const FIT_POINTS: Record<Fit, number> = { full: 2, partial: 1.5, slow: 1, none: 0 };
const TOOLS_POINTS: Record<ToolSupport, number> = { yes: 1.5, unknown: 0.75, no: 0 };
const CODE_POINTS: Record<CodeQuality, number> = { strong: 1.5, good: 1, unknown: 0.5 };

const FIT_TEXT: Record<Fit, string> = {
  full: 'Tient en entier sur la carte graphique.',
  partial: 'Tient en partie sur la carte graphique, le reste en mémoire vive.',
  slow: 'Tient surtout en mémoire vive : attendez-vous à de la lenteur.',
  none: 'Trop gros pour cette machine.',
};
const TOOLS_TEXT: Record<ToolSupport, string> = {
  yes: 'Sait appeler des outils.',
  no: 'Ne sait pas appeler des outils.',
  unknown: 'Appel d\'outils inconnu : à essayer pour le savoir.',
};
const CODE_TEXT: Record<CodeQuality, string> = {
  strong: 'Réputé fort en code.',
  good: 'Conçu pour le code.',
  unknown: 'Qualité en code inconnue.',
};

export function scoreModel(input: { fit: Fit; tools: ToolSupport; code: CodeQuality }): ModelScore {
  const { fit, tools, code } = input;
  let stars = 0;
  if (fit !== 'none') {
    stars = FIT_POINTS[fit] + TOOLS_POINTS[tools] + CODE_POINTS[code];
    stars = Math.floor(stars * 2) / 2;
    if (tools === 'no') stars = Math.min(stars, 2);
    if (code === 'unknown') stars = Math.min(stars, 3.5);
    if (tools === 'unknown') stars = Math.min(stars, 3);
  }
  const sentence = `${FIT_TEXT[fit]} ${TOOLS_TEXT[tools]} ${CODE_TEXT[code]} Estimation, non mesurée.`;
  return { stars, fit, tools, code, estimated: true, sentence };
}

export interface RecommendationInput { model: CatalogueModel; variant: ModelVariant | null; score: ModelScore }
export type Recommendation =
  | { kind: 'install'; item: RecommendationInput }
  | { kind: 'try'; item: RecommendationInput }
  | { kind: 'none'; reason: 'no-fit' | 'offline' | 'gated-only' };

const best = (items: RecommendationInput[]) =>
  [...items].sort((a, b) => b.score.stars - a.score.stars || b.model.downloads - a.model.downloads)[0];

export function recommend(items: RecommendationInput[]): Recommendation {
  const eligible = items.filter((item) => !item.model.gated && item.variant !== null && item.score.fit !== 'none');
  const sure = best(eligible.filter((item) => item.score.tools === 'yes'));
  if (sure) return { kind: 'install', item: sure };
  const maybe = best(eligible.filter((item) => item.score.tools === 'unknown'));
  if (maybe) return { kind: 'try', item: maybe };
  return { kind: 'none', reason: items.length > 0 && items.every((item) => item.model.gated) ? 'gated-only' : 'no-fit' };
}
