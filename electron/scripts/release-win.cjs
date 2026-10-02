// Builds the Windows installer and uploads it to a DRAFT GitHub release. Publishing the draft is
// the user's own gesture. The GitHub token only ever lives in electron-builder's environment.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = 'JLSkyzer/openagenticskyzer';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function assertReleasable({ version, dirty, exists }) {
  if (!SEMVER.test(String(version))) throw new Error(`Version invalide dans package.json : ${version}`);
  if (dirty) throw new Error('Changements non commités dans electron/ : commite-les avant de publier.');
  if (exists) throw new Error(`La release v${version} existe déjà : monte la version dans package.json.`);
}

/** Only the given folder's subtree (electron/): the repo root holds unrelated work in progress. */
function isTreeDirty(cwd) {
  const result = run('git', ['status', '--porcelain', '--', '.'], { cwd });
  if (result.status !== 0) throw new Error(`git status a échoué : ${result.stderr.trim()}`);
  return result.stdout.trim() !== '';
}

function releaseExists(version, repo = REPO) {
  const result = run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'tagName']);
  if (result.status === 0) return true;
  if (/release not found|not found/i.test(result.stderr)) return false;
  throw new Error(`Impossible de vérifier la release sur GitHub : ${result.stderr.trim()}`);
}

function githubToken() {
  const result = run('gh', ['auth', 'token']);
  const token = result.stdout.trim();
  if (result.status !== 0 || !token) throw new Error('Jeton GitHub introuvable : lance `gh auth login`.');
  return token;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : path.join(__dirname, '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertReleasable({ version, dirty: isTreeDirty(root), exists: releaseExists(version) });
  const token = githubToken();
  if (dryRun) {
    process.stdout.write(`dry-run: v${version} publiable en brouillon (jeton GitHub lu, ${token.length} caractères, non affiché)\n`);
    return 0;
  }
  const env = { ...process.env, GH_TOKEN: token };
  const steps = [
    [process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'renderer-src/vite.config.mts']],
    [process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--publish', 'always']],
  ];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error(`Étape échouée : ${path.basename(args[0])}`);
  }
  process.stdout.write(`Brouillon v${version} déposé sur GitHub : relis-le puis publie-le (https://github.com/${REPO}/releases).\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { assertReleasable, isTreeDirty, releaseExists };
