import { runProcess } from './process.mts';

/**
 * Guards for git commands the app runs WITHOUT a user decision (the sidebar branch indicator, the
 * agent's read-only git tools). Git executes commands a repository declares in its own .git/config
 * or ships in .git/hooks; a folder the user merely opens must never get that far.
 *
 *  - core.fsmonitor names a command `git status` runs; ext:: is a transport that runs one;
 *  - log.showSignature makes `git log` run gpg.program on signed commits;
 *  - core.hooksPath points at a directory that cannot exist: `status`/`diff` refreshing the index
 *    otherwise run .git/hooks/post-index-change (verified, Git 2.55 Windows). From Node, git does
 *    not translate "/dev/null" on Windows (it would mean <drive>:\dev\null), hence NUL there;
 *  - --no-lazy-fetch (git >= 2.44): in a partial clone, reading a missing blob otherwise spawns a
 *    fetch that runs the repository's remote.<name>.uploadpack / core.sshCommand. -c protocol.*
 *    cannot stop it: a repo-local protocol.file.allow=always wins. The read then fails instead;
 *  - diff.submodule=short: with `diff`, git diffs inside the submodule in a child that does not
 *    inherit --no-ext-diff, running a diff driver from the submodule's own config.
 */
const FIXED_GUARDS = [
  '--no-lazy-fetch',
  '-c', 'diff.submodule=short',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'log.showSignature=false',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
];

/**
 * Status/diff of the work tree must not descend into submodules: a submodule's own config declares
 * filters the superproject's overrides cannot name. `dirty` (verified) keeps a moved submodule
 * commit visible but no longer reports changes inside a submodule's work tree; `untracked` still
 * recursed and ran the filter.
 */
export const NO_SUBMODULE_WORKTREES = '--ignore-submodules=dirty';

// Only the repository's own files are neutralised: global/system config (git-lfs…) is the user's.
const REPO_SCOPES = new Set(['local', 'worktree']);

/**
 * `-c` arguments that make a read-only git command safe in `cwd`: the fixed guards above, plus an
 * empty override for every filter / diff driver the repository's own config declares (an empty
 * filter command means "no filter"; an empty textconv makes git fail instead of running anything).
 *
 * Reads the config once (`git config` executes nothing; --includes follows include.path). Fails
 * closed: throws if the config cannot be read (corrupt file, timeout, git without --show-scope or
 * --no-lazy-fetch, i.e. older than 2.44) or a name cannot be overridden — the caller must then not
 * run its command.
 */
export async function readOnlyGitArgs(cwd: string, env: NodeJS.ProcessEnv, options: { timeout: number; signal?: AbortSignal }): Promise<string[]> {
  // --no-lazy-fetch here too: a git that does not know it fails now, before anything else runs.
  const result = await runProcess('git', ['--no-lazy-fetch', 'config', '--show-scope', '--includes', '--name-only', '-z', '--get-regexp', '^(filter|diff)\\.'],
    { cwd, env, timeout: options.timeout, signal: options.signal, maxBytes: 1024 * 1024 });
  if (result.timedOut || result.truncated) throw new Error('lecture de la configuration git interrompue');
  // --get-regexp exits 1 when nothing matches: that is "no entries", not a failure.
  const noMatch = result.code === 1 && !result.stdout && !result.stderr.trim();
  if (result.code !== 0 && !noMatch) {
    if (/no-lazy-fetch/.test(result.stderr)) throw new Error('git 2.44 ou plus récent est requis (option --no-lazy-fetch inconnue de la version installée)');
    throw new Error(result.stderr.trim() || `git config a échoué (code ${result.code})`);
  }

  // -z --name-only: "<scope>\0<key>\0" per entry. Keys are "<section>.<name>.<variable>", where only
  // <name> keeps its case and may itself contain dots.
  const fields = result.stdout.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('sortie de git config inattendue');
  const overrides: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i += 2) {
    const [scope, key] = [fields[i], fields[i + 1]];
    if (!REPO_SCOPES.has(scope)) continue;
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first === last) continue; // diff.external, diff.noprefix…: no driver name, nothing to run here
    const section = key.slice(0, first);
    const name = key.slice(first + 1, last);
    // "-c filter.a=b.clean=" would set "filter.a": such a name cannot be neutralised, so refuse.
    // A name that is not valid UTF-8 was decoded lossily (U+FFFD): overriding the decoded text would
    // target another key, and such bytes cannot even be passed on a Windows command line. Refuse.
    if (name.includes('=') || name.includes('\uFFFD')) throw new Error(`nom de ${section} impossible à neutraliser : ${JSON.stringify(name)}`);
    if (seen.has(`${section}.${name}`)) continue;
    seen.add(`${section}.${name}`);
    const variables = section === 'filter' ? ['clean=', 'smudge=', 'process=', 'required=false'] : ['command=', 'textconv='];
    for (const variable of variables) overrides.push('-c', `${section}.${name}.${variable}`);
  }
  return [...FIXED_GUARDS, ...overrides];
}
