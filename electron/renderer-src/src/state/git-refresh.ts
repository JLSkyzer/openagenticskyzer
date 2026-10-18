// The sidebar's git widget reads `git status` when a folder is activated — while that folder's
// indexing is starting in the background and writing <project>/.openagent/index/. Its .gitignore
// (« * ») exists for an instant as an empty file, so a read landing then reports `?? .openagent/`.
// The widget therefore reads again once the folder's indexing has settled, and only the LATEST read
// is ever shown: a slow first read must never overwrite a later one.

/** Runs reads and applies only the result of the latest one; an older or failed read applies nothing. */
export function createLatestWins<T>(apply: (value: T) => void) {
  let latest = 0;
  return {
    run(read: () => Promise<T>): void {
      const id = ++latest;
      read().then(
        value => { if (id === latest) apply(value); },
        () => { /* git absent, folder gone: the last shown value stays */ },
      );
    },
    /** Drops every read in flight (the folder changed, or the widget unmounted). */
    cancel(): void {
      latest++;
    },
  };
}

/** An index event ends the writes into the active folder: re-read its git status. Same folder test as
 * ChatProvider's index indicator (the worker names the canonical path the Sidebar activated). */
export function shouldRefreshGitOn(event: { folder: string; state: string }, activeFolder: string | null): boolean {
  return activeFolder !== null && event.folder === activeFolder && (event.state === 'ready' || event.state === 'error');
}
