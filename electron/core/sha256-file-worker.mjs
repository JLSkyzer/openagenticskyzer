// Runs in a node:worker_threads worker (core/model-download.mts::sha256File): hashing a file of several gigabytes must
// not hold the thread of the engine. It stops by itself when the parent raises the shared flag: a worker is never
// terminated from outside (tasks/lessons.md, 2026-10-24).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const hash = createHash('sha256');
let aborted = false;
for await (const chunk of createReadStream(workerData.path, { highWaterMark: 4 * 1024 * 1024 })) {
  if (Atomics.load(workerData.abort, 0) === 1) { aborted = true; break; }
  hash.update(chunk);
}
if (!aborted) parentPort.postMessage(hash.digest('hex'));
