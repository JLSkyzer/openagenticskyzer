// The diff edit_file returns (parity row 6, 2026-10-05). An edit replaces ONE occurrence, so the two texts differ in a
// single region: the common leading and trailing lines are context, everything between is the change. No LCS and no
// dependency — none of the app's dependencies ships a diff.

export const DIFF_MAX_LINES = 60;
export const DIFF_MAX_CHARS = 4000;
export const DIFF_TRUNCATED = '[diff tronqué]';
const CONTEXT_LINES = 3;

/** Lines of a text, without the empty element a final newline adds (as read_file counts them); CRLF or LF. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** One side of a hunk header, 1-based; an empty side names the line before it, as `diff -u` does. */
function range(start: number, count: number): string {
  return count === 0 ? `${start},0` : `${start + 1},${count}`;
}

/** The unified diff turning `before` into `after` for `path` (`--- a/` and `+++ b/` headers, one hunk, up to three
 * lines of context on each side). Empty when the two texts have the same lines. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const old = linesOf(before);
  const next = linesOf(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const removed = old.slice(head, old.length - tail);
  const added = next.slice(head, next.length - tail);
  if (!removed.length && !added.length) return '';
  const lead = Math.min(CONTEXT_LINES, head);
  const trail = Math.min(CONTEXT_LINES, tail);
  const start = head - lead;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${range(start, lead + removed.length + trail)} +${range(start, lead + added.length + trail)} @@`,
    ...old.slice(start, head).map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...old.slice(old.length - tail, old.length - tail + trail).map(line => ` ${line}`),
  ].join('\n');
}

/** `diff` whole when it fits in DIFF_MAX_LINES lines and DIFF_MAX_CHARS characters; otherwise cut so that the result,
 * DIFF_TRUNCATED on its own last line included, still fits in both. */
export function boundedDiff(diff: string): string {
  const lines = diff.split('\n');
  if (lines.length <= DIFF_MAX_LINES && diff.length <= DIFF_MAX_CHARS) return diff;
  const room = DIFF_MAX_CHARS - DIFF_TRUNCATED.length - 1;
  return `${lines.slice(0, DIFF_MAX_LINES - 1).join('\n').slice(0, room)}\n${DIFF_TRUNCATED}`;
}
