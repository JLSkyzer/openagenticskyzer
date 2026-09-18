// Run with Electron, not node. No window, provider request or real user config.
const { app, safeStorage } = require('electron');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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
  const home = await mkdtemp(join(tmpdir(), 'openagent-os-vault-'));
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const { Connections } = await import('../core/connections.mts');
    const service = new Connections({ home, cipher: safeStorage, environment: {} });
    await service.save(null, { provider: 'openrouter', model: 'fake-model', api_key: 'FAKE-OS-TEST-NOT-A-REAL-KEY' });
    const reopened = new Connections({ home, cipher: safeStorage, environment: {} });
    assert.equal((await reopened.resolve(null)).api_key === 'FAKE-OS-TEST-NOT-A-REAL-KEY', true);
    assert.equal('api_key' in await reopened.snapshot(null), false);

    // main.cjs must fold the resolved (plaintext) connection into the payload it forwards
    // to the Node worker for `send` — the worker needs the key to call the provider —
    // while never exposing it to the renderer (only the redacted snapshot() is).
    const { resolveSendPayload } = require('../main.cjs');
    const forwarded = await resolveSendPayload(reopened, { op: 'send', payload: { folder: null, text: 'hi' } });
    assert.equal(forwarded.payload.connection.api_key, 'FAKE-OS-TEST-NOT-A-REAL-KEY');
    assert.equal(forwarded.payload.text, 'hi');

    process.stdout.write(`PASS OS vault persistence and redaction (Electron ${process.versions.electron}, ${process.platform})\n`);
  } finally { await rm(home, { recursive: true, force: true }); }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL OS vault: ${error.code || error.name}\n`);
  await flush();
  app.exit(1);
});
