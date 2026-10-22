// The « Général » settings tab's text, in French. Pure: tested from electron/tests.
// A type-only import: core/turn-log.mts uses node:fs, which the page must never load (Vite erases this import).
import type { TurnLogLevel } from '../../../../core/turn-log.mts';

/** « Journal des tours » (core/turn-log.mts): the setting's three levels, in the order of TURN_LOG_LEVELS. */
export const TURN_LOG_OPTIONS: ReadonlyArray<{ value: TurnLogLevel; label: string }> = [
  { value: 'full', label: 'Complet (défaut)' },
  { value: 'metadata', label: 'Sans contenu' },
  { value: 'off', label: 'Désactivé' },
];
