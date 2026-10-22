// The status line of a running turn (components/TurnStatus.tsx): its French label and the durations it shows.
// Pure, so the unit tests load it with Node itself.
import type { TurnPhaseName, TurnTiming } from '../ipc/bridge';

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

/** What a screen reader is told: the label, with a load's progress in steps of 10 % so a percent-by-percent load is not
 * read out at every percent. The visible label keeps the exact percent. */
export function announcedLabel(phase: TurnPhase): string {
  if (phase.phase === 'loading' && phase.progress !== undefined) return phaseLabel({ ...phase, progress: Math.floor(phase.progress / 10) * 10 });
  return phaseLabel(phase);
}

export interface TurnStatusView {
  /** The live region's text (role="status"): changes only with the phase, never with the timer. */
  announced: string;
  /** The visible label, hidden from screen readers (the live region speaks for it). */
  label: string;
  /** The visible timer, hidden from screen readers; null when the send time is unknown. */
  timer: string | null;
}

/** Everything TurnStatus shows at `now`. */
export function turnStatusView(phase: TurnPhase, turnStartedAt: number | null, now: number): TurnStatusView {
  return { announced: announcedLabel(phase), label: phaseLabel(phase), timer: turnStartedAt === null ? null : formatElapsed(now - turnStartedAt) };
}

/** The line under a finished reply: '1ᵉʳ mot 4,2 s · total 12,8 s · 8,3 tok/s · chargement 35 s', each part only when
 * its figure exists (a warm turn has no load, a provider that gives no token count has no rate). */
export function timingLine(timing: TurnTiming): string {
  const parts: string[] = [];
  if (timing.firstTextMs !== undefined) parts.push(`1ᵉʳ mot ${formatDuration(timing.firstTextMs)}`);
  if (timing.totalMs !== undefined) parts.push(`total ${formatDuration(timing.totalMs)}`);
  if (timing.tokensPerSecond !== undefined) parts.push(`${timing.tokensPerSecond.toFixed(1).replace('.', ',')} tok/s`);
  if (timing.loadMs !== undefined) parts.push(`chargement ${formatDuration(timing.loadMs)}`);
  return parts.join(' · ');
}

/** The « Réflexion » block's summary: 'Réflexion…' while the model reasons, then 'Réflexion · 3,4 s' when the duration
 * is known, else 'Réflexion'. */
export function reasoningSummary(input: { streaming: boolean; ms?: number }): string {
  if (input.streaming) return 'Réflexion…';
  return input.ms === undefined ? 'Réflexion' : `Réflexion · ${formatDuration(input.ms)}`;
}
