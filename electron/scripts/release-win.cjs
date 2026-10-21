// Builds the Windows installer and uploads it to a DRAFT GitHub release. Publishing the draft is
// the user's own gesture. The GitHub token is read only once the renderer is built, and only ever
// lives in electron-builder's environment.
const { spawnSync } = require('node:child_process');
const { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
const MISSING_TOOL = {
  git: 'git introuvable : installe Git et vérifie qu\'il est dans le PATH.',
  gh: 'gh introuvable : installe GitHub CLI (https://cli.github.com) puis lance `gh auth login`.',
};
// electron-publish reads these from its environment: a prerelease flag would turn the draft into a PUBLIC
// prerelease, and GITHUB_RELEASE_TOKEN / GITHUB_TOKEN would replace the token passed as GH_TOKEN.
const BUILDER_ENV_DROPPED = new Set(['EP_PRE_RELEASE', 'EP_PRELEASE', 'GITHUB_RELEASE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'EP_DRAFT']);

/** Runs a command; a command that cannot even start (e.g. not installed) is a clear error, not a crash. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) {
    if (result.error.code === 'ENOENT' && MISSING_TOOL[command]) throw new Error(MISSING_TOOL[command]);
    throw new Error(`Impossible de lancer ${command} : ${result.error.message}`);
  }
  return result;
}

function assertReleasable({ version, dirty, ahead = 0, exists, tagged }) {
  if (!SEMVER.test(String(version))) throw new Error(`Version invalide dans package.json : ${version}`);
  if (dirty) throw new Error('Changements non commités dans electron/ : commite-les avant de publier.');
  if (ahead > 0) throw new Error(`${ahead} commit(s) local(aux) absent(s) de GitHub : pousse tes commits avant de publier.`);
  if (exists) throw new Error(`La release v${version} existe déjà : monte la version dans package.json.`);
  // A stale tag would carry the new draft once published: the release would point at old code.
  if (tagged) throw new Error(`Le tag v${version} existe déjà sur GitHub sans release : monte la version dans package.json (ou supprime ce tag s'il est obsolète).`);
}

/** "owner/repo" from package.json build.publish — the one GitHub entry electron-builder uploads to. */
function publishRepo(pkg) {
  const entries = [].concat(pkg?.build?.publish ?? []).filter(entry => entry && entry.provider === 'github');
  const [entry] = entries;
  const valid = name => typeof name === 'string' && GITHUB_NAME.test(name) && name !== '.' && name !== '..';
  if (entries.length !== 1 || !valid(entry.owner) || !valid(entry.repo)) {
    throw new Error('build.publish de package.json doit contenir exactement un fournisseur github avec owner et repo valides.');
  }
  return `${entry.owner}/${entry.repo}`;
}

/**
 * electron-builder's environment: the caller's, minus every variable that could make the release public or
 * swap the token (compared case-insensitively: Windows environment names are), plus a forced draft and the token.
 */
function builderEnv(env, token) {
  const kept = Object.entries(env).filter(([name]) => !BUILDER_ENV_DROPPED.has(name.toUpperCase()));
  return { ...Object.fromEntries(kept), EP_DRAFT: 'true', GH_TOKEN: token };
}

/** Only the given folder's subtree (electron/): the repo root holds unrelated work in progress. */
function isTreeDirty(cwd) {
  const result = run('git', ['status', '--porcelain', '--', '.'], { cwd });
  if (result.status !== 0) throw new Error(`git status a échoué : ${result.stderr.trim()}`);
  return result.stdout.trim() !== '';
}

const NO_UPSTREAM = 'Pas de branche amont pour la branche courante : pousse-la (git push -u) avant de publier.';

/**
 * Commits on the current branch that its upstream does not have. GitHub tags the draft on the
 * remote's head, so a build of unpushed commits would ship under a tag pointing at other code.
 */
function unpushedCommits(cwd) {
  const result = run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd });
  if (result.status !== 0) throw new Error(NO_UPSTREAM);
  return Number(result.stdout.trim());
}

/** The remote the current branch tracks (e.g. "origin"). */
function upstreamRemote(cwd) {
  const head = run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd });
  const ref = head.stdout.trim();
  if (head.status !== 0 || !ref) throw new Error(NO_UPSTREAM);
  const result = run('git', ['for-each-ref', '--format=%(upstream:remotename)', ref], { cwd });
  const remote = result.stdout.trim();
  if (result.status !== 0 || !remote) throw new Error(NO_UPSTREAM);
  return remote;
}

/** Whether refs/tags/v<version> exists on the upstream remote. Any failure to ask is an error, never "absent". */
function remoteTagExists(version, cwd) {
  const remote = upstreamRemote(cwd);
  const ref = `refs/tags/v${version}`;
  const result = run('git', ['ls-remote', '--tags', remote, ref], { cwd });
  if (result.status !== 0) throw new Error(`Impossible de vérifier le tag v${version} sur ${remote} : ${result.stderr.trim()}`);
  return result.stdout.split('\n').some(line => {
    const name = line.split('\t')[1]?.trim();
    return name === ref || name === `${ref}^{}`;
  });
}

// `gh` answers "not found" for a repository it cannot see too: check access before reading any absence.
function assertRepoAccess(repo) {
  const access = run('gh', ['repo', 'view', repo, '--json', 'name']);
  if (access.status !== 0) {
    throw new Error(`Dépôt GitHub ${repo} inaccessible (vérifie son nom et \`gh auth status\`) : ${access.stderr.trim()}`);
  }
}

function releaseExists(version, repo) {
  assertRepoAccess(repo);
  const result = run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'tagName']);
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr)) return false;
  throw new Error(`Impossible de vérifier la release sur GitHub : ${result.stderr.trim()}`);
}

/** Whether the tag v<version> exists on the GitHub repository the draft goes to (exact ref: 404 means absent). */
function githubTagExists(version, repo) {
  assertRepoAccess(repo);
  const result = run('gh', ['api', `repos/${repo}/git/ref/tags/v${version}`, '--jq', '.ref']);
  if (result.status === 0) return result.stdout.trim() === `refs/tags/v${version}`;
  if (/HTTP 404/.test(result.stderr)) return false;
  throw new Error(`Impossible de vérifier le tag v${version} sur GitHub : ${result.stderr.trim()}`);
}

function githubToken() {
  const result = run('gh', ['auth', 'token']);
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) throw new Error('Jeton GitHub introuvable : lance `gh auth login`.');
  return token;
}

function buildStep(root, args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Étape échouée : ${path.basename(args.find(arg => !arg.startsWith('--')))}`);
}

// The CUDA pack (hardware and offload, Task 12). The app ships resources/cuda-pack/manifest.json and downloads the
// parts it names from this release: the parts uploaded must be exactly the ones that manifest describes.
const CUDA_RUNTIME_REQUIRED = 'Dossier du runtime CUDA requis : --cuda-runtime <dossier>.';
const PACK_MANIFEST_MISMATCH = 'Le manifeste du pack CUDA ne correspond pas : lance npm run cuda-pack:build puis commite resources/cuda-pack/manifest.json.';
const PART_NAME = /^[A-Za-z0-9._+-]+$/;

/** gh arguments that add the pack's parts to the release (the draft) of `version`. */
function packUploadArgs(version, repo, partPaths) {
  return ['release', 'upload', `v${version}`, ...partPaths, '--repo', repo];
}

/** size and sha256 of a file, read in chunks (a part can be close to 2 GiB). */
function hashPart(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(file, 'r');
  let size = 0;
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, read)); size += read; }
  } finally { closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
}

/**
 * The pack built in `builtDir` is the one `manifest` (the committed copy the app ships) describes: every part under
 * 2 GiB (GitHub's limit per asset), present, of the same size and sha256, and the built manifest equal to it.
 */
function assertPackMatchesManifest(manifest, builtDir) {
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : [];
  if (parts.length === 0 || parts.some(part => typeof part?.name !== 'string' || !PART_NAME.test(part.name) || part.name.startsWith('.'))) {
    throw new Error(PACK_MANIFEST_MISMATCH);
  }
  for (const part of parts) {
    if (!(Number.isSafeInteger(part.size) && part.size >= 0)) throw new Error(PACK_MANIFEST_MISMATCH);
    if (part.size >= 2 ** 31) throw new Error(`Morceau du pack CUDA trop gros (2 Gio ou plus) : ${part.name}`);
  }
  for (const part of parts) {
    const file = path.join(builtDir, part.name);
    let stat = null;
    try { stat = lstatSync(file); } catch { /* absent */ }
    if (!stat || !stat.isFile()) throw new Error(`Morceau du pack CUDA absent : ${part.name}`);
    const actual = stat.size === part.size ? hashPart(file) : null;
    if (!actual || actual.size !== part.size || actual.sha256 !== part.sha256) throw new Error(`Morceau du pack CUDA différent du manifeste : ${part.name}`);
  }
  let built = null;
  try { built = JSON.parse(readFileSync(path.join(builtDir, 'manifest.json'), 'utf8')); } catch { /* absent or unreadable */ }
  if (!isDeepStrictEqual(built, manifest)) throw new Error(PACK_MANIFEST_MISMATCH);
}

/** Rebuilds the pack into <root>/build/cuda-pack from node_modules and `runtimeDir`, then checks it against the committed manifest. */
function buildCudaPack(root, manifestPath, runtimeDir) {
  const out = path.join(root, 'build', 'cuda-pack');
  buildStep(root, ['--experimental-strip-types', path.join(__dirname, 'cuda-pack.mts'), '--runtime', path.resolve(runtimeDir), '--out', out, '--node-modules', path.join(root, 'node_modules')], process.env);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertPackMatchesManifest(manifest, out);
  return { manifest, partPaths: manifest.parts.map(part => path.join(out, part.name)) };
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && !dryRun) throw new Error('--root est réservé aux tests : il n\'est accepté qu\'avec --dry-run.');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : path.join(__dirname, '..');
  // Once the app ships a pack manifest, every release carries that pack: its NVIDIA runtime folder is required.
  const manifestPath = path.join(root, 'resources', 'cuda-pack', 'manifest.json');
  const shipsPack = existsSync(manifestPath);
  const runtimeIndex = argv.indexOf('--cuda-runtime');
  const cudaRuntime = runtimeIndex >= 0 ? argv[runtimeIndex + 1] : undefined;
  if (shipsPack && (!cudaRuntime || cudaRuntime.startsWith('--'))) throw new Error(CUDA_RUNTIME_REQUIRED);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { version } = pkg;
  const repo = publishRepo(pkg);
  const dirty = isTreeDirty(root);
  const ahead = unpushedCommits(root);
  const exists = releaseExists(version, repo);
  const tagged = remoteTagExists(version, root) || githubTagExists(version, repo);
  assertReleasable({ version, dirty, ahead, exists, tagged });
  const pack = shipsPack ? buildCudaPack(root, manifestPath, cudaRuntime) : null;
  if (dryRun) {
    if (pack) process.stdout.write(`dry-run: pack CUDA ${pack.manifest.parts.length} morceau(x), ${pack.manifest.downloadBytes} octets, conforme au manifeste
`);
    const token = githubToken();
    process.stdout.write(`dry-run: v${version} publiable en brouillon sur ${repo} (jeton GitHub lu, ${token.length} caractères, non affiché)\n`);
    return 0;
  }
  buildStep(root, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'renderer-src/vite.config.mts'], process.env);
  const token = githubToken();
  buildStep(root, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'always'], builderEnv(process.env, token));
  // The pack's parts go to the draft electron-builder just created, beside the installer.
  if (pack) {
    const upload = run('gh', packUploadArgs(version, repo, pack.partPaths));
    if (upload.status !== 0) throw new Error(`Envoi du pack CUDA sur le brouillon v${version} échoué : ${upload.stderr.trim()}`);
  }
  process.stdout.write(`Brouillon v${version} déposé sur GitHub : relis-le puis publie-le (https://github.com/${repo}/releases).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { assertReleasable, publishRepo, builderEnv, isTreeDirty, unpushedCommits, remoteTagExists, releaseExists, githubTagExists, packUploadArgs, assertPackMatchesManifest };
