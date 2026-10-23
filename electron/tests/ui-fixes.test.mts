// Task 8 (turn diagnostics): the empty chat's text, and the CSS that keeps a long unbroken word from scrolling the
// chat sideways. The window proof of the wrap is chat-visual.cjs (run in Task 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyStateText } from '../renderer-src/src/state/empty-state.ts';

const src = (path: string) => readFile(new URL(`../renderer-src/src/${path}`, import.meta.url), 'utf8');

test('emptyStateText: the old text without a folder, an invitation with one', () => {
  assert.equal(emptyStateText(null), 'Ouvre un dossier pour commencer.');
  assert.equal(emptyStateText('C:/p'), 'Écris un message pour commencer.');
});

test('a long word wraps instead of scrolling the chat sideways: the CSS says so', async () => {
  const css = await src('markdown/markdown.css');
  const block = /\.oa-markdown\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'the .oa-markdown block exists');
  assert.match(block[1], /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.oa-markdown pre\s*\{[^}]*overflow-x:\s*auto/, 'code blocks keep their own horizontal scroll');

  assert.ok((await src('components/MessageBubble.tsx')).includes("overflowWrap: 'anywhere'"));

  const chat = await src('components/ChatView.tsx');
  const scroll = /<div[^>]*data-testid="oa-chat-scroll"[^>]*>/.exec(chat);
  assert.ok(scroll, 'the chat scroll container exists');
  assert.match(scroll[0], /overflow-y-auto/);
  assert.match(scroll[0], /overflow-x-hidden/);
});
