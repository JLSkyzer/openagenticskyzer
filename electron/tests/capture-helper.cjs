// capturePage() intermittently throws "UnknownVizError" in this environment (Chromium's
// GPU/Viz service, seen since Electron 44 — roughly 1 run in 7). It is not caused by the
// page under test, so retry a few times after forcing a fresh paint instead of failing
// the whole test on it. A capture can also never settle (no frame comes: the window is
// occluded, or Viz stalls — suspected in the trust-visual run that hung on 2026-10-04): each
// attempt is bounded, and an attempt with no answer counts as a failed one.
require('./no-onboarding.cjs'); // side effect: see that file

/** `promise`, or a rejection naming `what` after `ms` milliseconds. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function capturePng(win, attempts = 4, perAttemptMs = 8000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      win.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 300));
      return (await withTimeout(win.webContents.capturePage(), perAttemptMs, `capturePage (attempt ${attempt})`)).toPNG();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { capturePng, withTimeout };
