// The status line of a running turn (components/TurnStatus.tsx): its French label and the durations it shows.
// Pure, so the unit tests load it with Node itself.
import type { TurnPhaseName } from '../ipc/bridge';

export interface TurnPhase { phase: TurnPhaseName; progress?: number; tool?: string }

export function phaseLabel(phase: TurnPhase): string {
  switch (phase.phase) {
    case 'preparing': return 'Préparation…';
    case 'loading': return phase.progress === undefined ? 'Chargement du modèle…' : `Chargement du modèle… ${phase.progress} %`;
    case 'reading': return 'Lecture du message…';
    case 'thinking': return 'Réflexion…';
    case 'writing': return 'Écriture…';
    case 'tool': return `Outil : ${phase.tool ?? ''}…`;
    case 'stopping': return 'Arrêt en cours…';
  }
}

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** A measured duration: '4,2 s' under a minute (',0' dropped: '35 s'), '5 min 12 s' under an hour, else '1 h 02 min'. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const tenths = Math.round(safe / 100);
  if (tenths < 600) {
    const whole = Math.floor(tenths / 10);
    const decimal = tenths % 10;
    return decimal === 0 ? `${whole} s` : `${whole},${decimal} s`;
  }
  const seconds = Math.round(safe / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${twoDigits(seconds % 60)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${twoDigits(minutes % 60)} min`;
}

/** The live timer, in whole seconds: '0 s', '42 s', '5 min 07 s' (hours as minutes: it only counts one turn). */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${twoDigits(seconds % 60)} s`;
}
