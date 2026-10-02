import { runProcess } from './process.mts';

export interface GitStatus {
  branch: string;
  dirty: boolean;
}

// Opening a folder must never run code the repository brings: core.fsmonitor names a COMMAND that
// plain `git status` executes, and ext:: is a transport that runs one. Same guard as the git tools.
const NO_REPO_HOOKS = ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];

/**
 * Best-effort branch + dirty/clean for the sidebar widget. Returns null for anything that isn't
 * a usable git repo right now — not a repo, no branch name (detached HEAD with no ref), git
 * missing, timeout — the same silent-skip contract the previous NiceGUI sidebar's
 * `_fetch_git_status_sync` already had. Never throws: this only ever feeds a passive display,
 * never blocks anything the user is trying to do.
 */
export async function gitStatus(folder: string, timeout = 3000): Promise<GitStatus | null> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
  try {
    const branchResult = await runProcess('git', [...NO_REPO_HOOKS, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, env, timeout, maxBytes: 4096 });
    if (branchResult.code !== 0 || branchResult.timedOut) return null;
    const branch = branchResult.stdout.trim();
    if (!branch) return null;
    const statusResult = await runProcess('git', [...NO_REPO_HOOKS, 'status', '--porcelain'], { cwd: folder, env, timeout, maxBytes: 1024 * 1024 });
    if (statusResult.timedOut) return null;
    return { branch, dirty: statusResult.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}
