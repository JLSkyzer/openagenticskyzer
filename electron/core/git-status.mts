import { NO_SUBMODULE_WORKTREES, readOnlyGitArgs } from './git-safety.mts';
import { runProcess } from './process.mts';

export interface GitStatus {
  branch: string;
  dirty: boolean;
}

/**
 * Opening a folder must never run code the repository brings (fsmonitor, filters, hooks, submodule
 * filters…): see git-safety.mts. If the guard cannot be built, git is not run and the indicator
 * simply does not show.
 *
 * Best-effort branch + dirty/clean for the sidebar widget. Returns null for anything that isn't
 * a usable git repo right now — not a repo, no branch name (detached HEAD with no ref), git
 * missing, timeout — the same silent-skip contract the previous NiceGUI sidebar's
 * `_fetch_git_status_sync` already had. Never throws: this only ever feeds a passive display,
 * never blocks anything the user is trying to do.
 */
export async function gitStatus(folder: string, timeout = 3000): Promise<GitStatus | null> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
  try {
    const guard = await readOnlyGitArgs(folder, env, { timeout });
    const branchResult = await runProcess('git', [...guard, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, env, timeout, maxBytes: 4096 });
    if (branchResult.code !== 0 || branchResult.timedOut) return null;
    const branch = branchResult.stdout.trim();
    if (!branch) return null;
    // Changes inside a submodule's work tree are not reported (see NO_SUBMODULE_WORKTREES).
    const statusResult = await runProcess('git', [...guard, 'status', '--porcelain', NO_SUBMODULE_WORKTREES], { cwd: folder, env, timeout, maxBytes: 1024 * 1024 });
    // A failed status (corrupt index, a blob a partial clone may not fetch…) is not "clean".
    if (statusResult.timedOut || statusResult.code !== 0) return null;
    return { branch, dirty: statusResult.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}
