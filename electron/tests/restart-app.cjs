// Run with Electron, not node (tests/run-restart-app.cjs launches it). No window. Proves « Redémarrer maintenant »
// (op 'restart-app') through main.cjs's REAL handleBackendRequest, with the real Electron app of THIS process: the op
// answers, then the app quits through the normal path ('before-quit', then 'will-quit') and Electron starts a new
// instance once this one has exited. What gets relaunched is this script (same command line), never the real app:
// main.cjs is required as a library, so its own lifecycle (window, worker, tray, single-instance lock) never starts.
// The second instance only records that it ran, then exits. Everything it touches is under the run's temp folder.
const { app } = require('electron');
const { appendFileSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

const flag = process.argv.find(arg => arg.startsWith('--restart-log='));
const log = flag ? flag.slice('--restart-log='.length) : '';
const record = line => appendFileSync(log, `${line}\n`); // synchronous: survives an exit right after

if (!log) {
  process.stderr.write('FAIL restart-app: --restart-log=<file> is required\n');
  app.exit(2);
} else {
  app.setPath('userData', join(dirname(log), 'userData')); // never the default Electron profile
  if (existsSync(log)) {
    // The relaunched instance: it must never relaunch again.
    record(`relaunched pid=${process.pid}`);
    app.exit(0);
  } else {
    record(`first pid=${process.pid}`);
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => record('before-quit'));
    app.on('will-quit', () => record('will-quit'));
    app.whenReady().then(async () => {
      const main = require('../main.cjs');
      // main.cjs's sender check compares with its own mainWindow, which is never created here.
      const answer = await main.handleBackendRequest({ sender: undefined }, { op: 'restart-app' });
      record(`answer ${JSON.stringify(answer)}`);
      setTimeout(() => { record('FAIL the app did not quit within 10 s'); app.exit(3); }, 10000).unref();
    }).catch(error => {
      record(`FAIL ${error && error.stack || error}`);
      app.exit(1);
    });
  }
}
