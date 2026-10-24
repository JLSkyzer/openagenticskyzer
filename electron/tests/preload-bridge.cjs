// Run with Electron, not node. Verifies preload.cjs exposes a filtered, unsubscribable
// onAgentEvent (and onEstimateEvent) — not a generic relay of every backend-message payload (which also
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

    // The same proof for onEstimateEvent (hardware and offload): only the 'estimate' event reaches it, and
    // unsubscribing stops delivery.
    await win.webContents.executeJavaScript(`
      window.__estimates = [];
      window.__unsubscribeEstimate = window.openagent.onEstimateEvent(event => window.__estimates.push(event));
      true;
    `);
    send({ type: 'event', event: 'estimate', estimateId: 'e1', modelId: 'm1', state: 'cancelled' });
    send({ type: 'event', event: 'model', id: 'm1', name: 'x.gguf', missing: false, contextWindow: 16384, loaded: false }); // filtered out
    send({ type: 'event', event: 'agent', runId: 'r1', kind: 'done' }); // filtered out
    send({ type: 'response', id: 'y', ok: true, result: {} }); // filtered out
    await new Promise(resolve => setTimeout(resolve, 100));
    let estimates = await win.webContents.executeJavaScript('window.__estimates');
    assert.equal(estimates.length, 1, 'only the estimate event reaches onEstimateEvent');
    assert.equal(estimates[0].estimateId, 'e1');
    assert.equal(estimates[0].state, 'cancelled');
    await win.webContents.executeJavaScript('window.__unsubscribeEstimate()');
    send({ type: 'event', event: 'estimate', estimateId: 'e2', modelId: 'm1', state: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 100));
    estimates = await win.webContents.executeJavaScript('window.__estimates');
    assert.equal(estimates.length, 1, 'unsubscribe stops further estimate delivery');

    // onCudaPackEvent (hardware and offload, Task 10): only the 'cuda-pack' event reaches it, and unsubscribing stops delivery.
    await win.webContents.executeJavaScript(`
      window.__cudaPack = [];
      window.__unsubscribeCudaPack = window.openagent.onCudaPackEvent(event => window.__cudaPack.push(event));
      true;
    `);
    send({ type: 'event', event: 'cuda-pack', installId: 'i1', state: 'progress', receivedBytes: 1, totalBytes: 2 });
    send({ type: 'event', event: 'estimate', estimateId: 'e3', modelId: 'm1', state: 'cancelled' }); // filtered out
    send({ type: 'response', id: 'z', ok: true, result: {} }); // filtered out
    await new Promise(resolve => setTimeout(resolve, 100));
    let packEvents = await win.webContents.executeJavaScript('window.__cudaPack');
    assert.equal(packEvents.length, 1, 'only the cuda-pack event reaches onCudaPackEvent');
    assert.equal(packEvents[0].installId, 'i1');
    assert.equal(packEvents[0].state, 'progress');
    await win.webContents.executeJavaScript('window.__unsubscribeCudaPack()');
    send({ type: 'event', event: 'cuda-pack', installId: 'i1', state: 'done' });
    await new Promise(resolve => setTimeout(resolve, 100));
    packEvents = await win.webContents.executeJavaScript('window.__cudaPack');
    assert.equal(packEvents.length, 1, 'unsubscribe stops further cuda-pack delivery');

    // onEngineEvent (final fix wave: hardware-info may answer { initializing }, then the worker posts one 'engine'
    // event): only the 'engine' event reaches it, and unsubscribing stops delivery.
    await win.webContents.executeJavaScript(`
      window.__engine = [];
      window.__unsubscribeEngine = window.openagent.onEngineEvent(event => window.__engine.push(event));
      true;
    `);
    send({ type: 'event', event: 'engine', state: 'ready' });
    send({ type: 'event', event: 'cuda-pack', installId: 'i2', state: 'done' }); // filtered out
    send({ type: 'response', id: 'w', ok: true, result: { initializing: true } }); // filtered out
    await new Promise(resolve => setTimeout(resolve, 100));
    let engineEvents = await win.webContents.executeJavaScript('window.__engine');
    assert.equal(engineEvents.length, 1, 'only the engine event reaches onEngineEvent');
    assert.equal(engineEvents[0].state, 'ready');
    await win.webContents.executeJavaScript('window.__unsubscribeEngine()');
    send({ type: 'event', event: 'engine', state: 'error', message: 'x' });
    await new Promise(resolve => setTimeout(resolve, 100));
    engineEvents = await win.webContents.executeJavaScript('window.__engine');
    assert.equal(engineEvents.length, 1, 'unsubscribe stops further engine delivery');

    process.stdout.write(`PASS preload onAgentEvent, onEstimateEvent, onCudaPackEvent and onEngineEvent filter and unsubscribe (Electron ${process.versions.electron})\n`);
  } finally {
    win.destroy();
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL preload bridge: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
