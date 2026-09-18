// Run with Electron, not node. Verifies preload.cjs exposes a filtered, unsubscribable
// onAgentEvent — not a generic relay of every backend-message payload (which also
// carries request/response bookkeeping the renderer has no business seeing).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadURL('data:text/html,<title>preload-bridge-test</title>');

    await win.webContents.executeJavaScript(`
      window.__received = [];
      window.__unsubscribe = window.openagent.onAgentEvent(event => window.__received.push(event));
      true;
    `);

    // Mirrors exactly what main.cjs's backend.on('message', ...) does: relay any worker
    // message to the renderer on 'backend-message', unfiltered.
    const send = message => win.webContents.send('backend-message', message);
    send({ type: 'event', event: 'agent', runId: 'r1', kind: 'delta', text: 'hello' });
    send({ type: 'response', id: 'x', ok: true, result: {} }); // must be filtered out

    await new Promise(resolve => setTimeout(resolve, 100));
    let received = await win.webContents.executeJavaScript('window.__received');
    assert.equal(received.length, 1, 'only the agent event reaches onAgentEvent, not the response bookkeeping message');
    assert.equal(received[0].kind, 'delta');
    assert.equal(received[0].text, 'hello');

    await win.webContents.executeJavaScript('window.__unsubscribe()');
    send({ type: 'event', event: 'agent', runId: 'r1', kind: 'done' });
    await new Promise(resolve => setTimeout(resolve, 100));
    received = await win.webContents.executeJavaScript('window.__received');
    assert.equal(received.length, 1, 'unsubscribe stops further delivery');

    process.stdout.write(`PASS preload onAgentEvent filters and unsubscribes (Electron ${process.versions.electron})\n`);
  } finally {
    win.destroy();
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL preload bridge: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
