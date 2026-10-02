// Builds the Windows installer and uploads it to a DRAFT GitHub release. Publishing the draft is
// the user's own gesture. The GitHub token is read only once the renderer is built, and only ever
// lives in electron-builder's environment.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = 'JLSkyzer/openagenticskyzer';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MISSING_TOOL = {
  git: 'git introuvable : installe Git et vérifie qu\'il est dans le PATH.',
  gh: 'gh introuvable : installe GitHub CLI (https://cli.github.com) puis lance `gh auth login`.',
};

/** Runs a command; a command that cannot even start (e.g. not installed) is a clear error, not a crash. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) {
    if (result.error.code === 'ENOENT' && MISSING_TOOL[command]) throw new Error(MISSING_TOOL[command]);
    throw new Error(`Impossible de lancer ${command} : ${result.error.message}`);
  }
  return result;
}

function assertReleasable({ version, dirty, ahead = 0, exists }) {
  if (!SEMVER.test(String(version))) throw new Error(`Version invalide dans package.json : ${version}`);
  if (dirty) throw new Error('Changements non commités dans electron/ : commite-les avant de publier.');
  if (ahead > 0) throw new Error(`${ahead} commit(s) local(aux) absent(s) de GitHub : pousse tes commits avant de publier.`);
  if (exists) throw new Error(`La release v${version} existe déjà : monte la version dans package.json.`);
}

/** Only the given folder's subtree (electron/): the repo root holds unrelated work in progress. */
function isTreeDirty(cwd) {
  const result = run('git', ['status', '--porcelain', '--', '.'], { cwd });
  if (result.status !== 0) throw new Error(`git status a échoué : ${result.stderr.trim()}`);
  return result.stdout.trim() !== '';
}

/**
 * Commits on the current branch that its upstream does not have. GitHub tags the draft on the
 * remote's head, so a build of unpushed commits would ship under a tag pointing at other code.
 */
function unpushedCommits(cwd) {
  const result = run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd });
  if (result.status !== 0) {
    throw new Error('Pas de branche amont pour la branche courante : pousse-la (git push -u) avant de publier.');
  }
  return Number(result.stdout.trim());
}

function releaseExists(version, repo = REPO) {
  // `gh release view` also says "release not found" for a repository it cannot see: check access first.
  const access = run('gh', ['repo', 'view', repo, '--json', 'name']);
  if (access.status !== 0) {
    throw new Error(`Dépôt GitHub ${repo} inaccessible (vérifie son nom et \`gh auth status\`) : ${access.stderr.trim()}`);
  }
  const result = run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'tagName']);
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr)) return false;
  throw new Error(`Impossible de vérifier la release sur GitHub : ${result.stderr.trim()}`);
}

function githubToken() {
  const result = run('gh', ['auth', 'token']);
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) throw new Error('Jeton GitHub introuvable : lance `gh auth login`.');
  return token;
}

function buildStep(root, args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Étape échouée : ${path.basename(args[0])}`);
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && !dryRun) throw new Error('--root est réservé aux tests : il n\'est accepté qu\'avec --dry-run.');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : path.join(__dirname, '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertReleasable({ version, dirty: isTreeDirty(root), ahead: unpushedCommits(root), exists: releaseExists(version) });
  if (dryRun) {
    const token = githubToken();
    process.stdout.write(`dry-run: v${version} publiable en brouillon (jeton GitHub lu, ${token.length} caractères, non affiché)\n`);
    return 0;
  }
  buildStep(root, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'renderer-src/vite.config.mts'], process.env);
  const token = githubToken();
  buildStep(root, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'always'], { ...process.env, GH_TOKEN: token });
  process.stdout.write(`Brouillon v${version} déposé sur GitHub : relis-le puis publie-le (https://github.com/${REPO}/releases).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { assertReleasable, isTreeDirty, unpushedCommits, releaseExists };
