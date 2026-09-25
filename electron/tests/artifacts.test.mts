import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArtifact } from '../renderer-src/src/state/artifacts.ts';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';

test('extractArtifact returns the type (lowercased) and the trimmed content of the first supported block', () => {
  assert.deepEqual(extractArtifact('Voici :\n```html\n<p>salut</p>\n```\nfin'), { type: 'html', content: '<p>salut</p>' });
  assert.deepEqual(extractArtifact('```SVG\n  <svg/>  \n```'), { type: 'svg', content: '<svg/>' }, 'the fence is case-insensitive, the type is lowercased');
  assert.deepEqual(extractArtifact('```mermaid\ngraph TD; A-->B\n```'), { type: 'mermaid', content: 'graph TD; A-->B' });
  assert.deepEqual(extractArtifact('```markdown\n# Titre\n```'), { type: 'markdown', content: '# Titre' });
});

test('extractArtifact takes the FIRST supported block, and ignores blocks of other languages (artifact_panel.py::_ARTIFACT_RE)', () => {
  const text = '```python\nprint(1)\n```\n```svg\n<svg id="a"/>\n```\n```html\n<b>b</b>\n```';
  assert.deepEqual(extractArtifact(text), { type: 'svg', content: '<svg id="a"/>' });
  assert.equal(extractArtifact('```python\nprint(1)\n```'), null);
  assert.equal(extractArtifact('pas de bloc du tout'), null);
});

test('extractArtifact needs a newline after the language and a closing fence; the match is non-greedy and spans lines', () => {
  assert.equal(extractArtifact('```html <p>x</p>```'), null, 'no newline after the language');
  assert.equal(extractArtifact('```html\n<p>jamais fermé'), null, 'an unclosed fence is not an artifact');
  assert.deepEqual(extractArtifact('```html\nA\nB\n```\ntexte\n```'), { type: 'html', content: 'A\nB' }, 'stops at the first closing fence');
  assert.equal(extractArtifact('```htmlx\n<p/>\n```'), null, 'a longer language name is not html');
});

const withReply = (reply: string): ChatState => ({
  ...initialChatState, runId: 'r1', agentRunning: true,
  messages: [{ role: 'user', content: 'dessine' }, { role: 'assistant', content: reply }],
});

test('a finished turn whose reply holds an artifact opens the panel', () => {
  const next = chatReducer(withReply('Voilà\n```svg\n<svg/>\n```'), { type: 'agent-event', event: { kind: 'done', runId: 'r1' } as never });
  assert.deepEqual(next.artifact, { type: 'svg', content: '<svg/>' });
});

test('a finished turn without an artifact leaves an open panel alone (only a new artifact replaces it)', () => {
  const open = { ...withReply('juste du texte'), artifact: { type: 'html' as const, content: '<p>ancien</p>' } };
  const next = chatReducer(open, { type: 'agent-event', event: { kind: 'done', runId: 'r1' } as never });
  assert.deepEqual(next.artifact, { type: 'html', content: '<p>ancien</p>' });
});

test('only a turn that ENDED opens it: a Stop or an error does not, even if the partial reply holds a block', () => {
  for (const kind of ['stopped', 'error']) {
    const next = chatReducer(withReply('```html\n<p>partiel</p>\n```'), { type: 'agent-event', event: { kind, runId: 'r1', message: 'x' } as never });
    assert.equal(next.artifact, null, kind);
  }
});

test('the artifact is read from the LAST reply that has text, not from a tool-only turn after it', () => {
  const state: ChatState = {
    ...withReply('```markdown\n# vu\n```'), runId: 'r1',
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '```markdown\n# vu\n```' }, { role: 'assistant', content: '' }, { role: 'tool', content: 'ok' }],
  };
  assert.deepEqual(chatReducer(state, { type: 'agent-event', event: { kind: 'done', runId: 'r1' } as never }).artifact, { type: 'markdown', content: '# vu' });
});

test('artifact-closed closes the panel; a new folder starts without one', () => {
  const open = { ...initialChatState, artifact: { type: 'html' as const, content: '<p/>' } };
  assert.equal(chatReducer(open, { type: 'artifact-closed' }).artifact, null);
  assert.equal(chatReducer(open, { type: 'folder-loaded', messages: [] }).artifact, null, 'a project’s preview does not follow you into another project');
});

test('switching branch keeps the panel (as the NiceGUI app did)', () => {
  const open = { ...initialChatState, artifact: { type: 'html' as const, content: '<p/>' } };
  assert.notEqual(chatReducer(open, { type: 'branch-switched', id: 'b', messages: [] }).artifact, null);
});
