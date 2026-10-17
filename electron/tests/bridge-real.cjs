// Plain Node script. Launches the REAL, unmocked app (the packaged exe -> main.cjs and its real
// worker) and exercises IPC ops through window.openagent.request over CDP — the same path the
// bridge functions in renderer-src/src/ipc/bridge.ts take: the connection ops are gone (local
// models only), model-status answers from the worker, and project settings round-trip to disk.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp } = require('./cdp-helper.cjs');

async function main() {
  const electronDir = path.join(__dirname, '..');
  const home = await mkdtemp(join(tmpdir(), 'openagent-bridge-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-bridge-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-bridge-userdata-'));
  const port = 9337;
  // The packaged exe (npm run package:win): `electron .` on the unpackaged tree opens no
  // window here, and the packaged build is what actually ships anyway.
  const child = spawn(path.join(electronDir, 'release', 'win-unpacked', 'openagent.exe'), [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_DISABLE_UPDATES: '1' },
    stdio: 'ignore',
  });
  let cdp;
  try {
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000 });
    cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // Runs one IPC request in the page and reports either its value or its rejection message.
    const ipc = (op, payload) => cdp.evaluate(
      `window.openagent.request(${JSON.stringify({ op, payload })}).then(value => ({ ok: true, value }), error => ({ ok: false, message: String(error && error.message || error) }))`,
      true,
    );
    // Local models only: the real main.cjs answers no connection op any more, and opens no vault at startup.
    for (const op of ['connection-snapshot', 'save-connection']) {
      const answer = await ipc(op, { folder: null });
      assert.equal(answer.ok, false, `${op} is no longer answered`);
      assert.match(answer.message, /Opération IPC inconnue/, `${op}: refused by the allow-list`);
    }
    // The model status comes from the real worker: no .gguf active on a fresh data home.
    const status = await ipc('model-status');
    assert.ok(status.ok, `model-status failed: ${status.message}`);
    assert.deepEqual(status.value, { id: '', name: null, missing: false, contextWindow: 16384, loaded: false });
    assert.equal(existsSync(join(home, 'connections.v1.json')), false, 'no vault file is ever written');

    // Project settings round trip, persisted where the legacy layout keeps them.
    const before = await ipc('project-settings', { folder: project });
    assert.ok(before.ok);
    assert.equal(before.value.agent_mode, 'inherit');
    const after = await ipc('save-project-settings', { folder: project, patch: { agent_mode: 'plan', custom_prompt: 'sois bref' } });
    assert.ok(after.ok, `save-project-settings failed: ${after.message}`);
    assert.equal(after.value.agent_mode, 'plan');
    const onDisk = JSON.parse(await readFile(join(project, '.openagent', 'config.json'), 'utf8'));
    assert.equal(onDisk.agent_mode, 'plan');
    assert.equal(onDisk.custom_prompt, 'sois bref');
    const rejected = await ipc('save-project-settings', { folder: project, patch: { agent_mode: 'nimporte-quoi' } });
    assert.equal(rejected.ok, false, 'an invalid value is rejected, not silently stored');

    process.stdout.write('PASS IPC through the real app: no connection op, model-status from the worker, project settings round trip\n');
  } finally {
    cdp?.close();
    child.kill();
    await Promise.all([home, project, userData].map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

main().catch(error => {
  process.stderr.write(`FAIL bridge real: ${error.stack || error}\n`);
  process.exitCode = 1;
});
