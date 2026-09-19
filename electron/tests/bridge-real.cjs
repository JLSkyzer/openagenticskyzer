// Plain Node script. Launches the REAL, unmocked app (`electron .` -> main.cjs, its real
// safeStorage vault and real worker) and exercises the connection / project-settings IPC
// ops through window.openagent.request over CDP — the same path the bridge functions in
// renderer-src/src/ipc/bridge.ts take. Proves the secret API key never comes back to the
// renderer and never reaches disk in clear text.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp } = require('./cdp-helper.cjs');

const SECRET = 'sk-SECRET-XYZ';

async function main() {
  const electronDir = path.join(__dirname, '..');
  const home = await mkdtemp(join(tmpdir(), 'openagent-bridge-home-'));
  const project = await mkdtemp(join(tmpdir(), 'openagent-bridge-project-'));
  const userData = await mkdtemp(join(tmpdir(), 'openagent-bridge-userdata-'));
  const port = 9337;
  // The packaged exe (npm run package:win): `electron .` on the unpackaged tree opens no
  // window here, and the packaged build is what actually ships anyway.
  const child = spawn(path.join(electronDir, 'release', 'win-unpacked', 'openagent.exe'), [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    env: { ...process.env, OPENAGENT_HOME: home },
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
    const assertNoSecret = (label, value) => {
      const text = JSON.stringify(value);
      assert.ok(!text.includes(SECRET), `${label}: the API key must never come back to the renderer`);
      assert.ok(!/api_key"\s*:/.test(text) && !text.includes('key_endpoint'), `${label}: no api_key / key_endpoint field in the renderer-facing reply`);
    };

    const saved = await ipc('save-connection', {
      folder: null,
      patch: { provider: 'openrouter', model: 'm1', base_url: 'http://127.0.0.1:9/v1', api_key: SECRET },
      authorization: { confirmEndpoint: false },
    });
    assert.ok(saved.ok, `save-connection failed: ${saved.message}`);
    assertNoSecret('save-connection reply', saved.value);
    assert.equal(saved.value.key_configured, true);
    assert.equal(saved.value.model, 'm1');

    const snapshot = await ipc('connection-snapshot', { folder: null });
    assert.ok(snapshot.ok);
    assertNoSecret('connection-snapshot reply', snapshot.value);
    assert.equal(snapshot.value.key_configured, true);

    const vaultRaw = await readFile(join(home, 'connections.v1.json'), 'utf8');
    assert.ok(!vaultRaw.includes(SECRET), 'the vault file on disk must not contain the key in clear text');
    assert.equal(JSON.parse(vaultRaw).version, 1, 'the vault is the encrypted envelope');

    // Re-binding a keyed profile to another URL must be refused until explicitly confirmed.
    const refused = await ipc('save-connection', {
      folder: null,
      patch: { provider: 'openrouter', base_url: 'http://127.0.0.1:10/v1' },
      authorization: { confirmEndpoint: false },
    });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /Confirmation requise/);
    const confirmed = await ipc('save-connection', {
      folder: null,
      patch: { provider: 'openrouter', base_url: 'http://127.0.0.1:10/v1' },
      authorization: { confirmEndpoint: true },
    });
    assert.ok(confirmed.ok, `confirmed save failed: ${confirmed.message}`);
    assert.equal(confirmed.value.base_url, 'http://127.0.0.1:10/v1');
    assertNoSecret('confirmed save reply', confirmed.value);

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

    process.stdout.write('PASS connection + project-settings IPC through the real app: secret never returned nor stored in clear\n');
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
