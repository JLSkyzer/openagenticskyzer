import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { terminateAtEnd } from './teardown.mts';
import { callWorker, phasesOf, recordAgentEvents } from './support/worker-events.mts';

const agent = (runId: string, event: Record<string, unknown>) =>
  `{ type: 'event', event: 'agent', runId: ${JSON.stringify(runId)}, ...${JSON.stringify(event)} }`;

test('recordAgentEvents catches an event posted right after a reply, and of() keeps one run apart', async t => {
  const source = `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', message => {
      parentPort.postMessage({ id: message.id, ok: true, result: { runId: 'r1' } });
      parentPort.postMessage(${agent('r1', { kind: 'phase', phase: 'preparing' })});
      parentPort.postMessage(${agent('r2', { kind: 'delta', text: 'autre' })});
      parentPort.postMessage(${agent('r1', { kind: 'phase', phase: 'loading', progress: 10 })});
      parentPort.postMessage(${agent('r1', { kind: 'phase', phase: 'loading', progress: 20 })});
      parentPort.postMessage(${agent('r1', { kind: 'phase', phase: 'reading' })});
      parentPort.postMessage(${agent('r1', { kind: 'done' })});
    });`;
  const worker = new Worker(source, { eval: true });
  terminateAtEnd(t, worker);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  await callWorker(worker, 'send');
  const events = await rec.until('r1');
  assert.deepEqual(events.map(e => e.kind), ['phase', 'phase', 'phase', 'phase', 'done']);
  assert.deepEqual(phasesOf(events), ['preparing', 'loading', 'reading']);
  assert.deepEqual(rec.of('r2').map(e => e.kind), ['delta']);
});

test('until rejects with the run id and the last kind seen when the end never comes', async t => {
  const source = `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', message => {
      parentPort.postMessage({ id: message.id, ok: true, result: { runId: 'r1' } });
      parentPort.postMessage(${agent('r1', { kind: 'phase', phase: 'loading' })});
    });`;
  const worker = new Worker(source, { eval: true });
  terminateAtEnd(t, worker);
  const rec = recordAgentEvents(worker);
  t.after(() => rec.stop());
  await callWorker(worker, 'send');
  await assert.rejects(rec.until('r1', { timeoutMs: 200 }), { message: 'until(r1) timed out; last kind: phase' });
});
