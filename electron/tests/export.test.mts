import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml, buildJson, buildMarkdown, exportFilename, renderEntries } from '../core/export.mts';

const categoryOf = (name: string): string | undefined =>
  ({ run_command: 'shell', create_file: 'write', edit_file: 'write', read_file: 'read', list_dir: 'read', internet_search: 'network', fetch_url: 'network' }[name]);

const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

test('renderEntries turns a user + assistant exchange into two entries', () => {
  const entries = renderEntries([
    { role: 'user', content: 'Bonjour' },
    { role: 'assistant', content: 'Salut !' },
  ], categoryOf);
  assert.deepEqual(entries, [
    { kind: 'user', content: 'Bonjour' },
    { kind: 'assistant', content: 'Salut !' },
  ]);
});

test('renderEntries reads legacy roles human/ai the same as user/assistant', () => {
  const entries = renderEntries([{ role: 'human', content: 'a' }, { role: 'ai', content: 'b' }], categoryOf);
  assert.deepEqual(entries.map(e => e.kind), ['user', 'assistant']);
});

test('renderEntries skips a system message and an assistant turn that only calls a tool (empty content, exactly what the screen shows)', () => {
  const entries = renderEntries([
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'lis le fichier' },
    { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'read_file', { path: 'a.py' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'contenu' },
    { role: 'assistant', content: 'voilà' },
  ], categoryOf);
  assert.deepEqual(entries.map(e => e.kind), ['user', 'tool', 'assistant']);
});

test('renderEntries resolves the tool name and tag from the preceding tool_calls, and the category comes from the real registered category', () => {
  const entries = renderEntries([
    { role: 'user', content: 'lance la commande' },
    { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'run_command', { command: 'pnpm test' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'OK' },
  ], categoryOf);
  const tool = entries.find(e => e.kind === 'tool')!;
  assert.equal(tool.toolName, 'run_command');
  assert.equal(tool.tag, 'run', 'category "shell" is tagged "run", like _TOOL_TAGS in gui_callback.py');
});

test('renderEntries maps every category to the same tag vocabulary as the NiceGUI app', () => {
  const tagOf = (name: string) => {
    const entries = renderEntries([
      { role: 'assistant', content: '', tool_calls: [toolCall('c', name, {})] },
      { role: 'tool', tool_call_id: 'c', content: '' },
    ], categoryOf);
    return entries[0].tag;
  };
  assert.equal(tagOf('create_file'), 'write');
  assert.equal(tagOf('read_file'), 'read');
  assert.equal(tagOf('internet_search'), 'search');
  assert.equal(tagOf('unknown_tool'), 'read', 'unregistered tool defaults to read, like _TOOL_TAGS.get(name, "read")');
});

test('renderEntries derives tool_detail from the arguments: path, then command, then query, then the raw arguments — each truncated to 120', () => {
  const detailOf = (args: unknown) => {
    const entries = renderEntries([
      { role: 'assistant', content: '', tool_calls: [toolCall('c', 'read_file', args)] },
      { role: 'tool', tool_call_id: 'c', content: '' },
    ], categoryOf);
    return entries[0].detail;
  };
  assert.equal(detailOf({ path: 'src/a.py', ignored: 1 }), 'src/a.py');
  assert.equal(detailOf({ command: 'pnpm test' }), 'pnpm test');
  assert.equal(detailOf({ query: 'openagent' }), 'openagent');
  assert.equal(detailOf({ other: 'x' }), JSON.stringify({ other: 'x' }));
  const long = 'x'.repeat(200);
  assert.equal(detailOf({ path: long }), long.slice(0, 120));
});

test('renderEntries copes with a tool message whose call was never seen (an unknown name, not a crash)', () => {
  const entries = renderEntries([{ role: 'tool', tool_call_id: 'inconnu', content: 'x' }], categoryOf);
  assert.equal(entries[0].toolName, undefined);
  assert.equal(entries[0].tag, 'read');
});

test('exportFilename: conversation_YYYYMMDD_HHMMSS.ext, from the given date', () => {
  assert.equal(exportFilename('md', new Date(2026, 8, 23, 9, 5, 3)), 'conversation_20260923_090503.md');
  assert.equal(exportFilename('html', new Date(2026, 11, 1, 23, 59, 0)), 'conversation_20261201_235900.html');
});

test('buildMarkdown: header, then a section per message', () => {
  const entries = renderEntries([{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Salut !' }], categoryOf);
  const markdown = buildMarkdown(entries, { folder: 'D:\\proj', model: 'llama3', provider: 'ollama', date: new Date(2026, 8, 23, 9, 5) });
  assert.match(markdown, /^# Conversation — 2026-09-23 09:05\n/);
  assert.match(markdown, /Dossier : `D:\\proj`\n/);
  assert.match(markdown, /Modèle : `llama3` \(ollama\)\n\n---\n/);
  assert.match(markdown, /\n## 👤 Utilisateur\n\nBonjour\n/);
  assert.match(markdown, /\n## 🤖 Assistant\n\nSalut !\n/);
});

test('buildMarkdown quotes EVERY line of a multiline tool message, blank lines included (a Markdown blockquote otherwise closes on the first blank line)', () => {
  const entries = renderEntries([
    { role: 'assistant', content: '', tool_calls: [toolCall('c', 'list_dir', {})] },
    { role: 'tool', tool_call_id: 'c', content: 'file1.py\nfile2.py\n\nsubdir/\n  a.py' },
  ], categoryOf);
  const markdown = buildMarkdown(entries, { folder: '/p', model: 'm', provider: 'p', date: new Date() });
  const block = markdown.split('---\n', 2)[1];
  for (const line of block.split('\n')) {
    if (line.trim()) assert.ok(line.startsWith('>'), `line outside the blockquote: ${JSON.stringify(line)}`);
  }
  assert.match(block, /subdir\//);
  assert.match(block, /^>   a\.py$/m);
  assert.match(block, /\*\*\[READ\]\*\* `list_dir` —/);
});

test('buildHtml escapes a code block exactly once: a raw "<" must render as &lt;, not &amp;lt;', () => {
  const entries = renderEntries([{ role: 'assistant', content: 'before\n```python\nx = "<b>"\n```\nafter' }], categoryOf);
  const html = buildHtml(entries, { model: 'm', date: new Date() });
  assert.match(html, /<pre><code class='language-python'>x = &quot;&lt;b&gt;&quot;\n<\/code><\/pre>/);
  assert.equal(html.includes('&amp;lt;'), false);
  assert.equal(html.includes('&amp;quot;'), false);
  assert.equal(html.includes('&amp;gt;'), false);
});

test('buildHtml escapes plain (non-code) user content too', () => {
  const entries = renderEntries([{ role: 'user', content: '<script>alert(1)</script>' }], categoryOf);
  const html = buildHtml(entries, { model: 'm', date: new Date() });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('buildJson: one object per entry, tool fields present (null when not a tool)', () => {
  const entries = renderEntries([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [toolCall('c', 'read_file', { path: 'x.py' })] },
    { role: 'tool', tool_call_id: 'c', content: 'contenu' },
  ], categoryOf);
  const data = JSON.parse(buildJson(entries));
  assert.deepEqual(data, [
    { role: 'user', content: 'a', tool_name: null, tool_tag: null, tool_detail: null },
    { role: 'tool', content: 'contenu', tool_name: 'read_file', tool_tag: 'read', tool_detail: 'x.py' },
  ]);
});
