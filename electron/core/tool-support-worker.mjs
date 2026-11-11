// Runs in a node:worker_threads worker (core/catalogue-service.mts::ToolSupportChecker): a chat template downloaded from
// Hugging Face is untrusted Jinja, and checking it takes from 30 ms to over 20 s, or forever for a loop that never ends
// (ruling T1b). It runs here, never on the engine's thread. Pure JavaScript, no native call: the parent may end this
// thread at its time limit.
import { parentPort } from 'node:worker_threads';
import { toolSupportOf } from './model-capabilities.mts';

parentPort.on('message', ({ id, template }) => {
  let result;
  try { result = toolSupportOf(template); } catch { result = 'unknown'; }
  parentPort.postMessage({ id, result });
});
parentPort.postMessage({ ready: true });
