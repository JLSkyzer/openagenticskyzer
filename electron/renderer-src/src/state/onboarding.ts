// onboarding.py: the first-launch wizard, its four steps and what decides whether it shows.
export const STEPS = ['welcome', 'model', 'folder', 'done'] as const;
export type OnboardingStep = (typeof STEPS)[number];

// The last screen's shortcuts. The original listed four, three of which do not exist in the NiceGUI app either
// (Ctrl+L, Ctrl+,) or are wrong ("Ctrl+Entrée — Envoyer": Enter sends, Ctrl+Enter makes a new line). Only what this
// app really does is shown.
export const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: 'Ctrl+K', label: 'Palette de commandes' },
  { keys: 'Entrée', label: 'Envoyer le message' },
  { keys: 'Shift+Entrée', label: 'Nouvelle ligne' },
];

/**
 * `should_show_onboarding`: not shown once `onboarding_done` is truthy (Python's `bool(...)`). No answer at all —
 * the settings could not be read — means NO wizard: an unreadable file must never lock the app behind a dialog.
 */
export function shouldShowOnboarding(settings: Record<string, unknown> | null): boolean {
  if (settings === null) return false;
  return !settings.onboarding_done;
}

/** One step forward or back, staying inside the wizard. */
export function stepAfter(step: OnboardingStep, direction: 'next' | 'back'): OnboardingStep {
  const index = STEPS.indexOf(step) + (direction === 'next' ? 1 : -1);
  return STEPS[Math.min(STEPS.length - 1, Math.max(0, index))];
}
