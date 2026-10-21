import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('../scripts/release-win.cjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ghReady = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;
const PUBLISH = [{ provider: 'github', owner: 'JLSkyzer', repo: 'openagenticskyzer', releaseType: 'draft' }];

async function cleanRepo(t: any, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version, build: { publish: PUBLISH } }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

/** A clean repo whose current branch tracks a local bare remote, in sync. */
async function pushedRepo(t: any, version: string) {
  const root = await cleanRepo(t, version);
  const remote = await mkdtemp(join(tmpdir(), 'openagent-release-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  const pushed = git(root, 'push', '-q', '-u', 'origin', 'HEAD');
  assert.equal(pushed.status, 0, pushed.stderr);
  return root;
}

function pushTag(root: string, tag: string) {
  assert.equal(git(root, 'tag', tag).status, 0);
  const pushed = git(root, 'push', '-q', 'origin', `refs/tags/${tag}`);
  assert.equal(pushed.status, 0, pushed.stderr);
}

function withoutPath(fn: () => void) {
  const saved = process.env.PATH;
  process.env.PATH = join(tmpdir(), 'openagent-release-no-such-dir');
  try { fn(); } finally { process.env.PATH = saved; }
}

test('assertReleasable refuses a dirty tree, unpushed commits, an existing release or tag and an invalid version', () => {
  const { assertReleasable } = require(SCRIPT);
  assert.doesNotThrow(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 0, exists: false, tagged: false }));
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: true, ahead: 0, exists: false, tagged: false }), /non commités/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 2, exists: false, tagged: false }), /pousse tes commits avant de publier/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 0, exists: true, tagged: false }), /La release v0\.3\.0 existe déjà/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 0, exists: false, tagged: true }), /Le tag v0\.3\.0 existe déjà/);
  assert.throws(() => assertReleasable({ version: 'abc', dirty: false, ahead: 0, exists: false, tagged: false }), /Version invalide/);
});

test('publishRepo reads owner/repo from build.publish, and refuses anything ambiguous', () => {
  const { publishRepo } = require(SCRIPT);
  assert.equal(publishRepo({ build: { publish: PUBLISH } }), 'JLSkyzer/openagenticskyzer');
  assert.equal(publishRepo({ build: { publish: { provider: 'github', owner: 'a', repo: 'b' } } }), 'a/b', 'a single object is accepted, as electron-builder does');
  for (const bad of [
    {},
    { build: {} },
    { build: { publish: [] } },
    { build: { publish: [{ provider: 'generic', url: 'https://example.com' }] } },
    { build: { publish: [{ provider: 'github', owner: 'a' }] } },
    { build: { publish: [{ provider: 'github', owner: 'a', repo: '../b' }] } },
    { build: { publish: [{ provider: 'github', owner: 'a', repo: 'b' }, { provider: 'github', owner: 'c', repo: 'd' }] } },
  ]) {
    assert.throws(() => publishRepo(bad), /build\.publish/, JSON.stringify(bad));
  }
});

test('the real package.json publishes to the GitHub repository the app reads its updates from', async () => {
  const { publishRepo } = require(SCRIPT);
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(publishRepo(pkg), 'JLSkyzer/openagenticskyzer');
});

test('builderEnv forces a draft, drops prerelease and competing token variables (any case), and never mutates its input', () => {
  const { builderEnv } = require(SCRIPT);
  const input = {
    PATH: 'C:\\bin',
    EP_PRE_RELEASE: 'true',
    EP_PRELEASE: 'true',
    GITHUB_RELEASE_TOKEN: 'fake-release-token',
    Github_Token: 'fake-lowercase-token',
    gh_token: 'fake-stale-token',
    EP_DRAFT: 'false',
    ep_pre_release: 'true',
  };
  const before = structuredClone(input);
  const env = builderEnv(input, 'fake-token-for-test');
  assert.deepEqual(env, { PATH: 'C:\\bin', EP_DRAFT: 'true', GH_TOKEN: 'fake-token-for-test' });
  assert.deepEqual(input, before, 'the input is untouched');
});

test('remoteTagExists asks the upstream remote for exactly refs/tags/v<version>', async t => {
  const { remoteTagExists } = require(SCRIPT);
  const root = await pushedRepo(t, '0.0.1');
  assert.equal(remoteTagExists('0.0.1', root), false, 'no tag yet');
  assert.equal(git(root, 'tag', 'v0.0.1').status, 0);
  assert.equal(remoteTagExists('0.0.1', root), false, 'a local tag that was never pushed is not on the remote');
  pushTag(root, 'v0.0.10');
  assert.equal(remoteTagExists('0.0.1', root), false, 'v0.0.10 is not v0.0.1');
  assert.equal(git(root, 'push', '-q', 'origin', 'refs/tags/v0.0.1').status, 0);
  assert.equal(remoteTagExists('0.0.1', root), true, 'the pushed tag is seen');
});

test('remoteTagExists fails closed: no upstream, or an unreachable remote', async t => {
  const { remoteTagExists } = require(SCRIPT);
  const lonely = await cleanRepo(t, '0.0.1');
  assert.throws(() => remoteTagExists('0.0.1', lonely), /branche amont/);
  const root = await pushedRepo(t, '0.0.1');
  assert.equal(git(root, 'remote', 'set-url', 'origin', join(tmpdir(), 'openagent-release-no-such-remote')).status, 0);
  assert.throws(() => remoteTagExists('0.0.1', root), /Impossible de vérifier le tag v0\.0\.1/);
});

test('githubTagExists reads the real GitHub refs: 404 is absent, a real tag is present, an unseen repo is refused', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { githubTagExists } = require(SCRIPT);
  assert.equal(githubTagExists('0.0.0-never-released', 'JLSkyzer/openagenticskyzer'), false);
  assert.equal(githubTagExists('2.0.0', 'cli/cli'), true, 'gh CLI itself has a v2.0.0 tag');
  assert.throws(() => githubTagExists('0.0.1', 'JLSkyzer/this-repository-does-not-exist-7f3a'), /inaccessible/);
});

test('isTreeDirty reads the real git state of the given folder', async t => {
  const { isTreeDirty } = require(SCRIPT);
  const root = await cleanRepo(t, '0.0.1');
  assert.equal(isTreeDirty(root), false);
  await writeFile(join(root, 'new.txt'), 'x');
  assert.equal(isTreeDirty(root), true);
});

test('unpushedCommits counts local commits ahead of the upstream and refuses a branch without one', async t => {
  const { unpushedCommits } = require(SCRIPT);
  const synced = await pushedRepo(t, '0.0.1');
  assert.equal(unpushedCommits(synced), 0);
  await writeFile(join(synced, 'later.txt'), 'x');
  git(synced, 'add', '.');
  git(synced, 'commit', '-qm', 'not pushed');
  assert.equal(unpushedCommits(synced), 1);
  const lonely = await cleanRepo(t, '0.0.1');
  assert.throws(() => unpushedCommits(lonely), /branche amont/);
});

test('a missing git or gh is reported clearly, not as a crash', () => {
  const { isTreeDirty, releaseExists, remoteTagExists, githubTagExists } = require(SCRIPT);
  withoutPath(() => {
    assert.throws(() => isTreeDirty(tmpdir()), /git introuvable/);
    assert.throws(() => remoteTagExists('0.0.1', tmpdir()), /git introuvable/);
    assert.throws(() => releaseExists('0.0.1', 'JLSkyzer/openagenticskyzer'), /gh introuvable : installe GitHub CLI/);
    assert.throws(() => githubTagExists('0.0.1', 'JLSkyzer/openagenticskyzer'), /gh introuvable : installe GitHub CLI/);
  });
});

test('--root is a test seam: refused without --dry-run, before anything else runs', async t => {
  // Invalid version on purpose: even a script that ignored the rule would stop before any build or network call.
  const root = await cleanRepo(t, 'abc');
  const refused = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--root/);
  assert.doesNotMatch(refused.stderr, /Version invalide/);
});

test('releaseExists asks the real GitHub repository', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.equal(releaseExists('0.0.0-never-released', 'JLSkyzer/openagenticskyzer'), false);
});

test('releaseExists refuses to read "not found" for a repository it cannot see', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.throws(() => releaseExists('0.0.1', 'JLSkyzer/this-repository-does-not-exist-7f3a'), /inaccessible/);
});

test('--dry-run checks everything, never prints the token, and refuses a dirty tree or unpushed commits', { skip: ghReady ? false : 'gh CLI not authenticated' }, async t => {
  const root = await pushedRepo(t, '0.0.1-dry');
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
  const ok = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /dry-run/);
  assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token never appears');

  await writeFile(join(root, 'later.txt'), 'x');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'not pushed');
  const ahead = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(ahead.status, 0);
  assert.match(ahead.stderr, /pousse tes commits avant de publier/);

  await writeFile(join(root, 'dirty.txt'), 'x');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /non commités/);
});

test('--dry-run refuses once the tag v<version> exists on the upstream remote', { skip: ghReady ? false : 'gh CLI not authenticated' }, async t => {
  const root = await pushedRepo(t, '0.0.1-dry');
  const ok = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  pushTag(root, 'v0.0.1-dry');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Le tag v0\.0\.1-dry existe déjà/);
});

// The CUDA pack in the release (hardware and offload, Task 12): its parts go to the same draft as the installer, and
// the pack built for the release must be byte for byte the one the committed manifest (shipped in the app) describes.
test('packUploadArgs uploads every part to the draft of the version', () => {
  const { packUploadArgs } = require(SCRIPT);
  assert.deepEqual(
    packUploadArgs('0.3.0', 'JLSkyzer/openagenticskyzer', ['a.part1', 'a.part2']),
    ['release', 'upload', 'v0.3.0', 'a.part1', 'a.part2', '--repo', 'JLSkyzer/openagenticskyzer'],
  );
});

test('packUploadError says the draft is incomplete, not to publish it, and gives the recovery command', () => {
  const { packUploadError } = require(SCRIPT);
  const message = packUploadError('0.3.0', 'JLSkyzer/openagenticskyzer', ['C:\\out\\a.part1', 'C:\\out\\a.part2'], ' HTTP 502 \n');
  assert.equal(
    message,
    'Envoi du pack CUDA sur le brouillon v0.3.0 échoué : HTTP 502\n'
    + 'Le brouillon v0.3.0 est incomplet (installateur sans pack CUDA) : ne le publie pas.\n'
    + 'Pour terminer l\'envoi : gh release upload v0.3.0 "C:\\out\\a.part1" "C:\\out\\a.part2" --repo JLSkyzer/openagenticskyzer --clobber',
  );
});

test('assertPackMatchesManifest refuses a missing part, another hash, a part of 2 GiB or more; accepts the built pack', async t => {
  const { assertPackMatchesManifest } = require(SCRIPT);
  const { writePack } = await import('../core/cuda-pack-format.mts');
  const root = await mkdtemp(join(tmpdir(), 'openagent-release-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [];
  // Random bytes: gzip cannot shrink them below the 4096-byte part size, so the pack has several parts.
  for (const [path, bytes] of [['cuda-runtime/a.dll', randomBytes(30_000)], ['cuda-runtime/LICENSE.txt', 'licence\n']] as const) {
    const source = join(root, path.replace('/', '-'));
    await writeFile(source, bytes);
    sources.push({ path, source });
  }
  const built = join(root, 'built');
  const manifest = await writePack(sources, built, { nodeLlamaCppVersion: '3.21.1', chunkBytes: 4096 });
  assert.ok(manifest.parts.length >= 2, 'several parts');
  const committed = JSON.parse(await readFile(join(built, 'manifest.json'), 'utf8'));
  assert.doesNotThrow(() => assertPackMatchesManifest(committed, built));

  const [first, second] = committed.parts;
  const huge = structuredClone(committed);
  huge.parts[1] = { ...second, size: 2 ** 31 };
  assert.throws(() => assertPackMatchesManifest(huge, built), { message: `Morceau du pack CUDA trop gros (2 Gio ou plus) : ${second.name}` });
  const other = structuredClone(committed);
  other.parts[0] = { ...first, sha256: '0'.repeat(64) };
  assert.throws(() => assertPackMatchesManifest(other, built), { message: `Morceau du pack CUDA différent du manifeste : ${first.name}` });
  const extra = structuredClone(committed);
  extra.installedBytes += 1;
  assert.throws(() => assertPackMatchesManifest(extra, built), { message: 'Le manifeste du pack CUDA ne correspond pas : lance npm run cuda-pack:build puis commite resources/cuda-pack/manifest.json.' });

  const bytes = await readFile(join(built, second.name));
  bytes[0] ^= 0xff;
  await writeFile(join(built, second.name), bytes);
  assert.throws(() => assertPackMatchesManifest(committed, built), { message: `Morceau du pack CUDA différent du manifeste : ${second.name}` });
  await rm(join(built, second.name));
  assert.throws(() => assertPackMatchesManifest(committed, built), { message: `Morceau du pack CUDA absent : ${second.name}` });
});

test('the committed CUDA pack manifest: format 1, the installed node-llama-cpp version, every part under 2 GiB', async () => {
  const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../resources/cuda-pack/manifest.json', import.meta.url)), 'utf8'));
  const engine = JSON.parse(await readFile(fileURLToPath(new URL('../node_modules/node-llama-cpp/package.json', import.meta.url)), 'utf8')).version;
  assert.equal(manifest.format, 1);
  assert.equal(manifest.nodeLlamaCppVersion, engine);
  assert.ok(manifest.parts.length >= 1);
  assert.ok(manifest.parts.every((part: { size: number }) => part.size < 2 ** 31), 'every part under 2 GiB');
  assert.equal(manifest.downloadBytes, manifest.parts.reduce((sum: number, part: { size: number }) => sum + part.size, 0));
});

test('--cuda-runtime is required once the app ships a CUDA pack manifest, refused before any git or GitHub call', async t => {
  // Invalid version on purpose: a script that reached the release checks would say so instead.
  const root = await cleanRepo(t, 'abc');
  await mkdir(join(root, 'resources', 'cuda-pack'), { recursive: true });
  await writeFile(join(root, 'resources', 'cuda-pack', 'manifest.json'), '{}\n');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stderr.trim(), 'Dossier du runtime CUDA requis : --cuda-runtime <dossier>.');
});
