// The « Matériel » settings tab's text, in French (hardware and offload, Task 7). Pure: tested from electron/tests.
import { formatBytes } from '../../../../core/units.mts';
import { LOCAL_CONTEXT_CHOICES, MIN_LOCAL_CONTEXT, type LocalContextSetting } from '../../../../core/context-budget.mts';
import type { Backend, HardwareInfo } from '../../ipc/types';

export type HardwareField = 'backend' | 'gpu' | 'vram' | 'ram' | 'cpu' | 'notice';

const BACKEND_LABELS: Record<Backend, string> = { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', cpu: 'processeur seul' };

/** What the machine offers, one line per field: no VRAM line without a card, the notice (if any) last. */
export function hardwareLines(info: HardwareInfo): Array<{ field: HardwareField; text: string }> {
  const lines: Array<{ field: HardwareField; text: string }> = [
    { field: 'backend', text: `Moteur : ${BACKEND_LABELS[info.backend]}` },
    { field: 'gpu', text: info.gpuNames.length ? `Carte : ${info.gpuNames.join(' + ')}` : 'Carte : aucune utilisée' },
  ];
  if (info.vram !== null) lines.push({ field: 'vram', text: `VRAM : ${formatBytes(info.vram.total)} au total, ${formatBytes(info.vram.free)} libres` });
  lines.push({ field: 'ram', text: `RAM : ${formatBytes(info.ram.total)} au total, ${formatBytes(info.ram.free)} libres` });
  lines.push({ field: 'cpu', text: `Processeur : ${info.cpu.model} — ${info.cpu.mathCores} cœurs de calcul` });
  if (info.notice !== null) lines.push({ field: 'notice', text: info.notice });
  return lines;
}

/** « Contexte des modèles locaux »: the five values of settings.mts::local_context. */
export const LOCAL_CONTEXT_OPTIONS: ReadonlyArray<{ value: LocalContextSetting; label: string }> = [
  { value: 16384, label: '16k' },
  { value: 32768, label: '32k (défaut)' },
  { value: 65536, label: '64k' },
  { value: 131072, label: '128k' },
  { value: 'max', label: 'max du modèle' },
];

const LARGEST_FIXED_CHOICE = Math.max(...LOCAL_CONTEXT_CHOICES.filter((choice): choice is Exclude<LocalContextSetting, 'max'> => choice !== 'max'));

/**
 * The top of the Contexte tab's max_tokens slider (ruling F6): the « Contexte des modèles locaux » setting, never
 * the engine's window — max_tokens only caps the request window, so reading it back from the engine would be
 * circular. No active model: MIN_LOCAL_CONTEXT, the window assumed then. 'max': the largest fixed choice, since the
 * renderer does not know the model's train size.
 */
export function maxTokensSliderMax(input: { hasModel: boolean; setting: LocalContextSetting }): number {
  if (!input.hasModel) return MIN_LOCAL_CONTEXT;
  return Math.max(MIN_LOCAL_CONTEXT, input.setting === 'max' ? LARGEST_FIXED_CHOICE : input.setting);
}
