// The « Matériel » settings tab's text, in French (hardware and offload, Task 7). Pure: tested from electron/tests.
import { formatBytes } from '../../../../core/units.mts';
import { LOCAL_CONTEXT_CHOICES, MIN_LOCAL_CONTEXT, type LocalContextSetting } from '../../../../core/context-budget.mts';
import type { Backend, CudaPackView, GpuBackendChoice, HardwareInfo } from '../../ipc/types';

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

// ── The CUDA pack and the engine choice (Task 11) ─────────────────────────────────────────────────────────────────
// The renderer cannot import core/cuda-pack.mts nor core/llama-runtime.mts (node-only): these texts mirror theirs, and
// tests/hardware-view.test.mts asserts they are equal.

/** core/cuda-pack.mts::CUDA_PACK_UNAVAILABLE. */
export const CUDA_PACK_UNAVAILABLE_TEXT = "Pack CUDA non disponible pour cette version de l'app.";

/** core/llama-runtime.mts::cudaMismatchNotice. */
export function cudaMismatchText(installed: string, expected: string): string {
  return `Le pack CUDA installé (moteur ${installed}) ne correspond plus à cette version de l'app (moteur ${expected}) : l'app utilise Vulkan. Télécharge le pack à jour.`;
}

/** Whether a hardware-info notice is core/llama-runtime.mts::cudaFallbackNotice (the installed pack failed to load),
 * not one of the notices that say nothing about the pack (cudaMissingNotice, backendFallbackNotice, the mismatch). */
export function isPackFailureNotice(notice: string | null): boolean {
  return notice !== null && notice.startsWith("Le pack CUDA n'a pas pu se charger : ");
}

export interface CudaPackUi {
  state: 'hidden' | 'unavailable' | 'absent' | 'installing' | 'installed' | 'restart' | 'mismatch' | 'failed';
  text: string;
  button: null | { id: 'download' | 'cancel' | 'uninstall' | 'restart'; label: string };
}

const sized = (label: string, bytes: number | null) => bytes === null ? label : `${label} (${formatBytes(bytes)})`;

/**
 * The CUDA pack block, in order of precedence. `progress`: the install this view started, while it runs. D-CUDA-4:
 * a pack installed or removed applies at the next app start, which view.restartRequired reports.
 */
export function cudaPackView(view: CudaPackView, info: HardwareInfo, progress: { received: number; total: number } | null): CudaPackUi {
  if (!info.nvidia && view.state !== 'installed') return { state: 'hidden', text: 'Aucune carte NVIDIA détectée : le pack CUDA ne servirait pas.', button: null };
  if (view.state === 'unavailable') return { state: 'unavailable', text: CUDA_PACK_UNAVAILABLE_TEXT, button: null };
  if (progress !== null) {
    const percent = progress.total > 0 ? Math.floor(100 * progress.received / progress.total) : 0;
    return { state: 'installing', text: `Téléchargement du pack CUDA… ${percent} %`, button: { id: 'cancel', label: 'Annuler' } };
  }
  // An install this view did not start (the tab was reopened): no cancel without its id.
  if (view.state === 'installing') return { state: 'installing', text: 'Installation du pack CUDA en cours…', button: null };
  if (view.state === 'mismatch') {
    return {
      state: 'mismatch',
      text: cudaMismatchText(view.installedVersion ?? '?', view.expectedVersion),
      button: { id: 'download', label: sized('Télécharger le pack à jour', view.downloadBytes) },
    };
  }
  if (view.state === 'installed') {
    if (isPackFailureNotice(info.notice)) return { state: 'failed', text: info.notice!, button: { id: 'uninstall', label: 'Désinstaller' } };
    if (view.restartRequired) return { state: 'restart', text: "Pack CUDA installé : redémarre l'app pour l'utiliser.", button: { id: 'restart', label: 'Redémarrer maintenant' } };
    return { state: 'installed', text: "Pack CUDA installé : utilisé au prochain chargement d'un modèle.", button: { id: 'uninstall', label: 'Désinstaller' } };
  }
  return {
    state: 'absent',
    text: "Le pack CUDA accélère les cartes NVIDIA. Il est téléchargé depuis la release de l'app et installé dans son dossier de données.",
    button: { id: 'download', label: sized('Télécharger le pack CUDA', view.downloadBytes) },
  };
}

/** « Moteur » (the gpu_backend setting), applied at the next app start. */
export const GPU_BACKEND_OPTIONS: ReadonlyArray<{ value: GpuBackendChoice; label: string }> = [
  { value: 'auto', label: 'Automatique (CUDA si le pack est installé, sinon Vulkan)' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'cpu', label: 'Processeur seul' },
];

/**
 * The restart offer under « Moteur »: when the selected choice (saved or not yet) differs from what this run started
 * with, or what is saved needs a restart. Never when the CUDA block already offers its own: one restart button in the tab.
 */
export function backendChoiceView(info: HardwareInfo, selected: GpuBackendChoice, cudaState: CudaPackUi['state']): {
  restart: null | { text: string; button: { id: 'restart'; label: string } };
} {
  if (cudaState === 'restart' || (selected === info.backendChoice && !info.restartRequired)) return { restart: null };
  return { restart: { text: "Le changement de moteur s'applique au prochain démarrage de l'app.", button: { id: 'restart', label: 'Redémarrer maintenant' } } };
}
