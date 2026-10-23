// The « Matériel » settings tab's French lines and its context choices (hardware and offload, Task 7). Pure.
// The machine values below are test inputs, not measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptInstall, backendChoiceView, CUDA_ADVICE, cudaAdvice, CUDA_PACK_UNAVAILABLE_TEXT, cudaMismatchText, cudaPackView, GPU_BACKEND_OPTIONS, hardwareLines,
  isPackFailureNotice, LOCAL_CONTEXT_OPTIONS, maxTokensSliderMax,
} from '../renderer-src/src/components/settings/hardware-view.ts';
// What op hardware-info answers: core/hardware.mts::HardwareInfo plus the worker's backendChoice and restartRequired.
import type { CudaPackView, HardwareInfo } from '../renderer-src/src/ipc/types.ts';

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

// ── The CUDA pack and the engine choice (hardware and offload, Task 11) ─────────────────────────────────────────────
// 1_288_490_189 bytes is a test input (formatBytes → '1,2 Gio'), not the real pack's size.
const absentPack: CudaPackView = {
  state: 'absent', downloadBytes: 1_288_490_189, installedBytes: 2_500_000_000, installedVersion: null,
  expectedVersion: '3.18.1', restartRequired: false, notice: null, install: null,
};
const installedPack: CudaPackView = { ...absentPack, state: 'installed', installedVersion: '3.18.1' };

test('cudaPackView: hidden without NVIDIA, the size before download, progress and cancel, installed, restart, mismatch, failed', () => {
  assert.deepEqual(cudaPackView(absentPack, { ...card, nvidia: false }, null), {
    state: 'hidden', text: 'Aucune carte NVIDIA détectée : le pack CUDA ne servirait pas.', button: null,
  });
  assert.deepEqual(cudaPackView({ ...absentPack, state: 'unavailable', downloadBytes: null }, card, null), {
    state: 'unavailable', text: "Pack CUDA non disponible pour cette version de l'app.", button: null,
  });
  assert.deepEqual(cudaPackView(absentPack, card, { received: 644_245_094, total: 1_288_490_189 }), {
    state: 'installing', text: 'Téléchargement du pack CUDA… 49 %', button: { id: 'cancel', label: 'Annuler' },
  });
  assert.deepEqual(cudaPackView({ ...absentPack, state: 'mismatch', installedVersion: '3.0.0' }, card, null), {
    state: 'mismatch',
    text: "Le pack CUDA installé (moteur 3.0.0) ne correspond plus à cette version de l'app (moteur 3.18.1) : l'app utilise Vulkan. Télécharge le pack à jour.",
    button: { id: 'download', label: 'Télécharger le pack à jour (1,2 Gio)' },
  });
  const failed = "Le pack CUDA n'a pas pu se charger : l'app utilise Vulkan à la place.";
  // The notice itself is the tab's notice line (hardwareLines): the block does not repeat it.
  assert.deepEqual(cudaPackView(installedPack, { ...card, notice: failed }, null), {
    state: 'failed', text: "Le pack CUDA est installé mais n'a pas pu se charger (voir le message ci-dessus).", button: { id: 'uninstall', label: 'Désinstaller' },
  });
  assert.deepEqual(cudaPackView({ ...installedPack, restartRequired: true }, card, null), {
    state: 'restart', text: "Pack CUDA installé : redémarre l'app pour l'utiliser.", button: { id: 'restart', label: 'Redémarrer maintenant' },
  });
  assert.deepEqual(cudaPackView(installedPack, card, null), {
    state: 'installed', text: "Pack CUDA installé : utilisé au prochain chargement d'un modèle.", button: { id: 'uninstall', label: 'Désinstaller' },
  });
  assert.deepEqual(cudaPackView(absentPack, card, null), {
    state: 'absent',
    text: "Le pack CUDA accélère les cartes NVIDIA. Il est téléchargé depuis la release de l'app et installé dans son dossier de données.",
    button: { id: 'download', label: 'Télécharger le pack CUDA (1,2 Gio)' },
  });

  // Precedence and edges.
  assert.equal(cudaPackView(installedPack, { ...card, nvidia: false }, null).state, 'installed', 'an installed pack stays visible without NVIDIA');
  assert.equal(cudaPackView(absentPack, card, { received: 5, total: 0 }).text, 'Téléchargement du pack CUDA… 0 %', 'no total yet: 0 %');
  assert.deepEqual(cudaPackView({ ...absentPack, state: 'installing' }, card, null), {
    state: 'installing', text: 'Installation du pack CUDA en cours…', button: null,
  }, 'an install this view did not start: no cancel without its id');
  // gpu_backend « cuda » started without the pack, then the pack installed: a restart, not a failure.
  const missing = "Le moteur CUDA est choisi, mais le pack CUDA n'est pas installé : l'app utilise Vulkan à la place. Installe le pack CUDA puis redémarre l'app.";
  assert.equal(cudaPackView({ ...installedPack, restartRequired: true }, { ...card, notice: missing }, null).state, 'restart');
  // A Vulkan that failed says nothing about the pack.
  assert.equal(cudaPackView(installedPack, { ...card, notice: "Le moteur Vulkan n'a pas pu se charger : l'app utilise le processeur à la place." }, null).state, 'installed');
});

test('the renderer\'s CUDA texts are the core\'s own, exactly (no drift)', async () => {
  const core = await import('../core/cuda-pack.mts');
  const runtime = await import('../core/llama-runtime.mts');
  assert.equal(CUDA_PACK_UNAVAILABLE_TEXT, core.CUDA_PACK_UNAVAILABLE);
  assert.equal(cudaMismatchText('3.0.0', '3.18.1'), runtime.cudaMismatchNotice('3.0.0', '3.18.1'));
  for (const backend of ['cuda', 'vulkan', 'metal', 'cpu'] as const) {
    assert.equal(isPackFailureNotice(runtime.cudaFallbackNotice(backend)), true, `cudaFallbackNotice(${backend})`);
    assert.equal(isPackFailureNotice(runtime.cudaMissingNotice(backend)), false, `cudaMissingNotice(${backend})`);
    assert.equal(isPackFailureNotice(runtime.backendFallbackNotice('vulkan', backend)), false, `backendFallbackNotice(${backend})`);
  }
  assert.equal(isPackFailureNotice(runtime.cudaMismatchNotice('3.0.0', '3.18.1')), false, 'the mismatch has its own state');
  assert.equal(isPackFailureNotice(null), false);
  // The tab's fallback for local_context (Task 7 minor): the shared default, the same as the settings' own.
  const { DEFAULT_LOCAL_CONTEXT } = await import('../core/context-budget.mts');
  assert.equal(DEFAULT_LOCAL_CONTEXT, (await import('../core/settings.mts')).globalDefaults.local_context);
});

test('backendChoiceView: the four choices in French; the restart offer once, only when the choice or the pack differs', () => {
  assert.deepEqual(GPU_BACKEND_OPTIONS, [
    { value: 'auto', label: 'Automatique (CUDA si le pack est installé, sinon Vulkan)' },
    { value: 'cuda', label: 'CUDA' },
    { value: 'vulkan', label: 'Vulkan' },
    { value: 'cpu', label: 'Processeur seul' },
  ]);
  const offer = { text: "Le changement de moteur s'applique au prochain démarrage de l'app.", button: { id: 'restart', label: 'Redémarrer maintenant' } };
  assert.deepEqual(backendChoiceView(card, 'auto', 'absent'), { restart: null }, 'nothing changed');
  assert.deepEqual(backendChoiceView(card, 'cpu', 'absent'), { restart: offer }, 'a choice not saved yet differs from what this run started with');
  assert.deepEqual(backendChoiceView({ ...card, restartRequired: true }, 'auto', 'absent'), { restart: offer }, 'saved, but this run started with another');
  assert.deepEqual(backendChoiceView({ ...card, restartRequired: true }, 'cpu', 'restart'), { restart: null }, 'the CUDA block already offers the one restart button');
  assert.deepEqual(backendChoiceView({ ...card, backendChoice: 'cpu' }, 'cpu', 'hidden'), { restart: null });
});

test('adoptInstall: a view mounted mid-install takes over its id and progress; never one it already follows', () => {
  const running = { ...absentPack, state: 'installing' as const, install: { installId: 'i-1', receivedBytes: 1000, totalBytes: 4000 } };
  assert.deepEqual(adoptInstall(running, null), { installId: 'i-1', progress: { received: 1000, total: 4000 } });
  assert.equal(adoptInstall(running, 'i-1'), null, 'already followed');
  assert.equal(adoptInstall(absentPack, null), null, 'nothing running');
  // Adopted, the block is back to its progress and « Annuler ».
  const adopted = adoptInstall(running, null)!;
  assert.deepEqual(cudaPackView(running, card, adopted.progress), {
    state: 'installing', text: 'Téléchargement du pack CUDA… 25 %', button: { id: 'cancel', label: 'Annuler' },
  });
});

test('cudaAdvice: only Vulkan on an NVIDIA card', () => {
  assert.equal(
    CUDA_ADVICE,
    'Sur les cartes NVIDIA, le pack CUDA est recommandé : avec Vulkan, une partie du modèle peut déborder en mémoire partagée et ralentir fortement les réponses.',
  );
  assert.equal(cudaAdvice(card), CUDA_ADVICE, 'vulkan + nvidia');
  assert.equal(cudaAdvice({ ...card, backend: 'cuda' }), null, 'cuda + nvidia');
  assert.equal(cudaAdvice({ ...card, gpuNames: ['AMD Radeon RX 7800 XT'], nvidia: false }), null, 'vulkan + AMD');
  assert.equal(cudaAdvice({ ...card, backend: 'cpu', gpuNames: [], vram: null, nvidia: false }), null, 'cpu');
});
