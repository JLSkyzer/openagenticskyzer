import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Real authenticated encryption substitutes for OS safeStorage in headless tests.
// A plaintext/Base64 vault, lost endpoint binding or wrong scope breaks these tests.
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-connections-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const a = join(root, 'a'); const b = join(root, 'b');
  await Promise.all([home, a, b].map(p => mkdir(p)));
  const { Connections } = await import('../core/connections.mts');
  const cipher = encryption();
  return { home, a, b, cipher, service: new Connections({ home, cipher, environment: {} }), Connections };
}

test('keys are encrypted at rest, omitted from UI snapshots and isolated across projects/providers', async t => {
  const { service, home, a, b, cipher, Connections } = await fixture(t);
  await service.save(null, { provider: 'openrouter', model: 'global-model', api_key: 'fake-global-secret' });
  await service.save(a, { provider: 'openrouter', model: 'project-model', api_key: 'fake-project-secret' });
  const reopened = new Connections({ home, cipher, environment: {} });
  assert.equal((await reopened.resolve(a)).api_key, 'fake-project-secret');
  assert.equal((await reopened.resolve(b)).api_key, 'fake-global-secret');
  const publicValue = await reopened.snapshot(a);
  assert.equal(publicValue.key_configured, true);
  assert.equal(publicValue.model, 'project-model');
  assert.equal('api_key' in publicValue, false);
  assert.equal(JSON.stringify(publicValue).includes('fake-project-secret'), false);
  const raw = await readFile(join(home, 'connections.v1.json'), 'utf8');
  assert.equal(raw.includes('fake-global-secret'), false);
  assert.equal(Buffer.from(JSON.parse(raw).payload, 'base64').toString().includes('fake-project-secret'), false);
  await reopened.save(a, { provider: 'groq', model: 'other-model' });
  assert.equal((await reopened.resolve(a)).api_key, '');
});

test('legacy .env is read without mutation, interpolation or process environment pollution', async t => {
  const { service, a } = await fixture(t);
  const original = '# preserve comments\r\nexport OPENROUTER_API_KEY="fake#legacy"\r\nOPENROUTER_MODEL=one,two\r\nEXAMPLE=${HOME}\r\n';
  await writeFile(join(a, '.env'), original);
  const before = { ...process.env };
  const result = await service.resolve(a);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.api_key, 'fake#legacy');
  assert.equal(result.model, 'one');
  assert.equal((await service.snapshot(a)).legacy_plaintext, true);
  await service.save(a, { provider: 'openrouter', model: 'chosen' });
  assert.equal((await service.resolve(a)).api_key, 'fake#legacy');
  assert.equal(await readFile(join(a, '.env'), 'utf8'), original);
  assert.equal(Object.keys(process.env).length, Object.keys(before).length);
  assert.equal(Object.entries(before).every(([key, value]) => process.env[key] === value), true, 'Le chargement ne doit pas modifier les variables du processus');
});

test('endpoint changes cannot silently forward a saved or inherited key', async t => {
  const { service, a, b } = await fixture(t);
  await service.save(null, { provider: 'openrouter', api_key: 'fake-sensitive', model: 'model' });
  await assert.rejects(service.save(a, { provider: 'openrouter', base_url: 'https://other.example/v1' }), /confirmation/i);
  assert.equal((await service.resolve(a)).base_url, 'https://openrouter.ai/api/v1');
  await service.save(a, { provider: 'openrouter', base_url: 'https://other.example/v1' }, { confirmEndpoint: true });
  assert.equal((await service.resolve(a)).base_url, 'https://other.example/v1');
  assert.equal((await service.resolve(b)).base_url, 'https://openrouter.ai/api/v1');
  await assert.rejects(service.save(a, { provider: 'openrouter', base_url: 'http://public.example/v1' }, { confirmEndpoint: true }), /HTTPS/);
  await assert.rejects(service.save(a, { provider: 'openrouter', base_url: 'https://user:pass@example.com/v1' }), /URL/);
});

test('clearing a key suppresses legacy and inherited fallback without deleting the original env', async t => {
  const { service, a, b } = await fixture(t);
  await service.save(null, { provider: 'openrouter', api_key: 'fake-global' });
  await writeFile(join(a, '.env'), 'OPENROUTER_API_KEY=fake-legacy');
  await service.save(a, { provider: 'openrouter', api_key: null });
  assert.equal((await service.resolve(a)).api_key, '');
  assert.equal((await service.resolve(b)).api_key, 'fake-global');
  assert.equal(await readFile(join(a, '.env'), 'utf8'), 'OPENROUTER_API_KEY=fake-legacy');
});

test('unavailable encryption and a corrupt vault fail closed, never replace existing data', async t => {
  const { home, service, cipher, Connections } = await fixture(t);
  const locked = new Connections({ home, cipher: { ...cipher, isEncryptionAvailable: () => false }, environment: {} });
  await assert.rejects(locked.save(null, { provider: 'openrouter', api_key: 'fake' }), /chiffrement/i);
  await service.save(null, { provider: 'groq', api_key: 'fake' });
  const path = join(home, 'connections.v1.json');
  const damaged = '{"version":1,"payload":"broken"}';
  await writeFile(path, damaged);
  await assert.rejects(service.save(null, { provider: 'groq', model: 'new' }), /coffre/i);
  assert.equal(await readFile(path, 'utf8'), damaged);
});

test('saving a model retains endpoint consent without asking again or copying the global key', async t => {
  const { service, a } = await fixture(t);
  await service.save(null, { provider: 'openrouter', api_key: 'fake-one' });
  await service.save(a, { provider: 'openrouter', base_url: 'https://approved.example/v1' }, { confirmEndpoint: true });
  await service.save(a, { provider: 'openrouter', model: 'another' });
  await service.save(null, { provider: 'openrouter', api_key: 'fake-two' });
  assert.equal((await service.resolve(a)).api_key, 'fake-two');
  assert.equal((await service.resolve(a)).model, 'another');
});

test('consent granted on the global connection also covers a project that inherits it', async t => {
  const { service, a } = await fixture(t);
  await service.save(null, { provider: 'openrouter', api_key: 'fake-key', model: 'm' });
  await service.save(null, { provider: 'openrouter', base_url: 'https://approved.example/v1' }, { confirmEndpoint: true });
  // A project with no override of its own inherits both the key and the approved URL.
  const resolved = await service.resolve(a);
  assert.equal(resolved.base_url, 'https://approved.example/v1');
  assert.equal(resolved.api_key, 'fake-key');
});

test('consent is per key/URL pair: another project cannot borrow a different pair', async t => {
  const { service, a, b } = await fixture(t);
  await service.save(null, { provider: 'openrouter', api_key: 'fake-key' });
  await service.save(a, { provider: 'openrouter', base_url: 'https://approved.example/v1' }, { confirmEndpoint: true });
  assert.equal((await service.resolve(a)).base_url, 'https://approved.example/v1');
  // Project b never approved anything: it still sends the key to the original endpoint only.
  assert.equal((await service.resolve(b)).base_url, 'https://openrouter.ai/api/v1');
});

test('a JSON null vault is corrupt, not an invitation to reset credentials', async t => {
  const { home, service } = await fixture(t);
  const file = join(home, 'connections.v1.json');
  await writeFile(file, 'null');
  await assert.rejects(service.save(null, { provider: 'groq', api_key: 'fake' }), /coffre/i);
  assert.equal(await readFile(file, 'utf8'), 'null');
});

// Local models are only the .gguf files of the app's own library: ollama, lmstudio and llamacpp are no longer
// providers. A selection saved before that must open on openrouter with no model (the user then picks one),
// never throw — and the old entry is ignored, not deleted.
test('a vault scope that selects a removed provider resolves to openrouter with no model, and keeps the old entry', async t => {
  const { home, cipher, service } = await fixture(t);
  const vault = { scopes: { global: { provider: 'ollama', profiles: { ollama: { model: 'llama3', base_url: 'http://localhost:11434/v1' } } } } };
  const file = join(home, 'connections.v1.json');
  await writeFile(file, JSON.stringify({ version: 1, payload: cipher.encryptString(JSON.stringify(vault)).toString('base64') }));
  const resolved = await service.resolve(null);
  assert.equal(resolved.provider, 'openrouter');
  assert.equal(resolved.model, '');
  assert.equal(resolved.base_url, 'https://openrouter.ai/api/v1');
  assert.equal((await service.snapshot(null)).provider, 'openrouter');
  await service.save(null, { provider: 'groq', model: 'chosen' });
  assert.deepEqual([(await service.resolve(null)).provider, (await service.resolve(null)).model], ['groq', 'chosen']);
  const saved = JSON.parse(cipher.decryptString(Buffer.from(JSON.parse(await readFile(file, 'utf8')).payload, 'base64')));
  assert.deepEqual(saved.scopes.global.profiles.ollama, vault.scopes.global.profiles.ollama, 'the old entry is left as it was');
});

test('a legacy config.json that names a removed provider resolves to openrouter with no model', async t => {
  const { service, home, a } = await fixture(t);
  await writeFile(join(home, 'config.json'), JSON.stringify({ current_provider: 'lmstudio' }));
  await mkdir(join(a, '.openagent'));
  await writeFile(join(a, '.openagent', 'config.json'), JSON.stringify({ current_provider: 'lmstudio', current_model: 'qwen' }));
  for (const folder of [null, a]) {
    const resolved = await service.resolve(folder);
    assert.deepEqual([resolved.provider, resolved.model, resolved.base_url], ['openrouter', '', 'https://openrouter.ai/api/v1']);
  }
});

test('a legacy global .env holding only OLLAMA_MODEL no longer selects ollama', async t => {
  const { home, cipher, Connections } = await fixture(t);
  const legacyGlobalEnv = join(home, 'legacy.env');
  await writeFile(legacyGlobalEnv, 'OLLAMA_MODEL=llama3\n');
  const service = new Connections({ home, cipher, environment: { OLLAMA_API_KEY: 'fake-ollama' }, legacyGlobalEnv });
  const resolved = await service.resolve(null);
  assert.deepEqual([resolved.provider, resolved.model, resolved.base_url, resolved.api_key], ['openrouter', '', 'https://openrouter.ai/api/v1', '']);
});

test('saving a removed provider is refused, like any unknown provider', async t => {
  const { home, service } = await fixture(t);
  await assert.rejects(service.save(null, { provider: 'llamacpp' as any, model: 'x' }), /Provider invalide/);
  await assert.rejects(readFile(join(home, 'connections.v1.json')), /ENOENT/, 'nothing written');
});
