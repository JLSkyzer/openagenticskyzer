// capturePage() intermittently throws "UnknownVizError" in this environment (Chromium's
// GPU/Viz service, seen since Electron 44 — roughly 1 run in 7). It is not caused by the
// page under test, so retry a few times after forcing a fresh paint instead of failing
// the whole test on it.
async function capturePng(win, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      win.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 300));
      return (await win.webContents.capturePage()).toPNG();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { capturePng };
