import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedLabel, formatDuration, formatElapsed, phaseLabel, turnStatusView } from '../renderer-src/src/state/turn-status.ts';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';

const agent = (runId: string, kind: string, extra: object = {}) =>
  ({ type: 'agent-event' as const, event: { type: 'event', event: 'agent', runId, kind, ...extra } as any });
const started = (state: ChatState = initialChatState, startedAt = 1000): ChatState =>
  chatReducer(state, { type: 'send-started', runId: 'r1', text: 'bonjour', startedAt });

test('phaseLabel gives the seven exact French labels', () => {
  assert.equal(phaseLabel({ phase: 'preparing' }), 'Préparation…');
  assert.equal(phaseLabel({ phase: 'loading' }), 'Chargement du modèle…');
  assert.equal(phaseLabel({ phase: 'loading', progress: 42 }), 'Chargement du modèle… 42 %');
  assert.equal(phaseLabel({ phase: 'loading', progress: 0 }), 'Chargement du modèle… 0 %');
  assert.equal(phaseLabel({ phase: 'reading' }), 'Lecture du message…');
  assert.equal(phaseLabel({ phase: 'thinking' }), 'Réflexion…');
  assert.equal(phaseLabel({ phase: 'writing' }), 'Écriture…');
  assert.equal(phaseLabel({ phase: 'tool', tool: 'internet_search' }), 'Outil : internet_search…');
  assert.equal(phaseLabel({ phase: 'stopping' }), 'Arrêt en cours…');
});

test('formatDuration and formatElapsed', () => {
  assert.equal(formatDuration(4200), '4,2 s');
  assert.equal(formatDuration(12800), '12,8 s');
  assert.equal(formatDuration(35000), '35 s');
  assert.equal(formatDuration(312000), '5 min 12 s');
  assert.equal(formatDuration(3_725_000), '1 h 02 min');
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(42_400), '42 s');
  assert.equal(formatElapsed(307_000), '5 min 07 s');
});

test('reducer: send-started starts the timer in preparing; phase events follow the run; a stale run is ignored', () => {
  assert.equal(initialChatState.phase, null);
  assert.equal(initialChatState.turnStartedAt, null);
  assert.equal(initialChatState.stopping, false);
  const running = started();
  assert.equal(running.turnStartedAt, 1000);
  assert.deepEqual(running.phase, { phase: 'preparing' });
  assert.equal(running.stopping, false);
  const loading = chatReducer(running, agent('r1', 'phase', { phase: 'loading', progress: 42 }));
  assert.deepEqual(loading.phase, { phase: 'loading', progress: 42 });
  assert.equal(chatReducer(loading, agent('old', 'phase', { phase: 'writing' })), loading, 'another run changes nothing');
  const tool = chatReducer(loading, agent('r1', 'phase', { phase: 'tool', tool: 'internet_search' }));
  assert.deepEqual(tool.phase, { phase: 'tool', tool: 'internet_search' });
  // A reply of this run gets the turn's timing on done; an earlier turn's reply never does.
  const before = { ...initialChatState, messages: [{ role: 'user', content: 'avant' }, { role: 'assistant', content: 'ancienne' }] } as ChatState;
  const withReply = chatReducer(started(before), agent('r1', 'message', { message: { role: 'assistant', content: 'nouvelle' } }));
  const timing = { totalMs: 5000, firstTextMs: 1200 };
  const done = chatReducer(withReply, agent('r1', 'done', { timing }));
  assert.equal(done.phase, null);
  assert.equal(done.turnStartedAt, null);
  assert.equal(done.agentRunning, false);
  assert.deepEqual(done.messages[3].timing, timing);
  assert.equal(done.messages[1].timing, undefined, 'an earlier turn keeps its own figures');
  // A run that produced no reply puts its timing nowhere.
  const bare = chatReducer(started(before), agent('r1', 'stopped', { timing }));
  assert.equal(bare.messages[1].timing, undefined);
  // An error carries no timing and resets the line.
  const failed = chatReducer(loading, agent('r1', 'error', { message: 'boom' }));
  assert.equal(failed.phase, null);
  assert.equal(failed.turnStartedAt, null);
});

test('reducer: stop-requested shows stopping at once and holds it; stopped clears it; stop-failed reports', () => {
  const running = chatReducer(started(), agent('r1', 'phase', { phase: 'reading' }));
  const stopping = chatReducer(running, { type: 'stop-requested' });
  assert.equal(stopping.stopping, true);
  assert.deepEqual(stopping.phase, { phase: 'stopping' });
  assert.equal(stopping.agentRunning, true);
  const held = chatReducer(stopping, agent('r1', 'phase', { phase: 'writing' }));
  assert.equal(held.stopping, true);
  assert.deepEqual(held.phase, { phase: 'stopping' });
  const stopped = chatReducer(held, agent('r1', 'stopped', {}));
  assert.equal(stopped.stopping, false);
  assert.equal(stopped.agentRunning, false);
  assert.equal(stopped.phase, null);
  assert.equal(stopped.turnStartedAt, null);
  // A done that beat the stop ends the turn as a done (ruling T3-m2).
  const doneAfterStop = chatReducer(held, agent('r1', 'done', {}));
  assert.equal(doneAfterStop.stopping, false);
  assert.equal(doneAfterStop.agentRunning, false);
  assert.equal(doneAfterStop.completedTurns, 1);
  assert.equal(chatReducer(initialChatState, { type: 'stop-requested' }), initialChatState, 'no run, nothing to stop');
  const failed = chatReducer(stopping, { type: 'stop-failed', error: 'x' });
  assert.equal(failed.stopping, false);
  assert.equal(failed.error, 'x');
});

test('the live region speaks the phase only: a timer tick never changes it, a load is announced every 10 %', () => {
  const writing = { phase: 'writing' as const };
  const before = turnStatusView(writing, 1000, 5_400);
  const after = turnStatusView(writing, 1000, 6_400);
  assert.notEqual(after.timer, before.timer, 'the visible timer ticked');
  assert.equal(after.announced, before.announced, 'the live region did not change on the tick');
  assert.equal(before.announced, 'Écriture…');
  assert.equal(turnStatusView(writing, null, 6_400).timer, null);
  // The visible label keeps the exact percent; the live region moves in steps of 10.
  const at42 = turnStatusView({ phase: 'loading', progress: 42 }, 1000, 2000);
  const at49 = turnStatusView({ phase: 'loading', progress: 49 }, 1000, 2000);
  assert.equal(at42.label, 'Chargement du modèle… 42 %');
  assert.equal(at49.label, 'Chargement du modèle… 49 %');
  assert.equal(at42.announced, 'Chargement du modèle… 40 %');
  assert.equal(at49.announced, at42.announced);
  assert.equal(announcedLabel({ phase: 'loading', progress: 50 }), 'Chargement du modèle… 50 %');
  assert.equal(announcedLabel({ phase: 'loading', progress: 100 }), 'Chargement du modèle… 100 %');
  assert.equal(announcedLabel({ phase: 'loading' }), 'Chargement du modèle…');
  assert.equal(announcedLabel({ phase: 'tool', tool: 'internet_search' }), 'Outil : internet_search…');
});

test('reducer: a failed stop brings back the worker phase; a late failure after the turn changes nothing', () => {
  const reading = chatReducer(started(), agent('r1', 'phase', { phase: 'reading' }));
  const stopping = chatReducer(reading, { type: 'stop-requested' });
  const failed = chatReducer(stopping, { type: 'stop-failed', error: 'x' });
  assert.deepEqual(failed.phase, { phase: 'reading' }, 'the phase shown before the stop');
  assert.equal(failed.stopping, false);
  // A phase the worker posted during the stop is the one it is really in: that one comes back.
  const moved = chatReducer(stopping, agent('r1', 'phase', { phase: 'writing' }));
  assert.deepEqual(moved.phase, { phase: 'stopping' }, 'still stopping on screen');
  assert.deepEqual(chatReducer(moved, { type: 'stop-failed', error: 'x' }).phase, { phase: 'writing' });
  // The turn ended before the stop's rejection came back: nothing to restore, no error to show.
  const ended = chatReducer(stopping, agent('r1', 'stopped', {}));
  assert.equal(chatReducer(ended, { type: 'stop-failed', error: 'late' }), ended);
  assert.equal(chatReducer(initialChatState, { type: 'stop-failed', error: 'late' }), initialChatState);
});
