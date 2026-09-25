import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_ATTRIBUTE, processUpload } from '../renderer-src/src/state/upload.ts';

// Expected values come from the REAL Python `process_upload` (file_processor.py), run on the same bytes.
const bytes = (text: string) => new TextEncoder().encode(text);

test('a text or code file is read as UTF-8; the size is at least 1 KB, floored', async () => {
  assert.deepEqual(await processUpload('notes.txt', bytes('salut é\n')), { name: 'notes.txt', content_type: 'text', content: 'salut é\n', size_kb: 1 });
  assert.equal((await processUpload('s.txt', bytes('abc')))?.size_kb, 1);
  assert.equal((await processUpload('s.txt', bytes('a'.repeat(3500))))?.size_kb, 3);
});

test('the extension is case-insensitive', async () => {
  assert.equal((await processUpload('MAIN.PY', bytes('print(1)')))?.content_type, 'text');
});

test('extensions are read like Python\'s Path.suffix: a bare dotfile has none, only the last dot counts', async () => {
  assert.equal(await processUpload('.env', bytes('A=1')), null, '".env" alone has NO suffix in pathlib, so it is unsupported (as in the original)');
  assert.equal((await processUpload('prod.env', bytes('A=1')))?.content_type, 'text');
  assert.equal(await processUpload('x.tar.gz', bytes('x')), null);
  assert.equal(await processUpload('Makefile', bytes('x')), null);
  assert.equal(await processUpload('run.exe', bytes('x')), null);
});

test('text is cut at 50 000 characters (code points, like Python), never in the middle of a character', async () => {
  const kept = (await processUpload('b.txt', bytes('é'.repeat(3000) + 'x'.repeat(60000))))!.content;
  assert.equal([...kept].length, 50000);
  const astral = (await processUpload('a.txt', bytes('😀'.repeat(50001))))!.content;
  assert.equal([...astral].length, 50000, 'an emoji counts as ONE character, like Python\'s len()');
  assert.equal(astral.endsWith('😀'), true, 'no half emoji at the cut');
});

test('an invalid byte is replaced, not fatal (errors="replace")', async () => {
  assert.equal((await processUpload('x.txt', new Uint8Array([0x61, 0xff, 0x62])))?.content, 'a�b');
});

test('an image becomes a data URI whose MIME follows the extension', async () => {
  assert.equal((await processUpload('p.PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47])))?.content, 'data:image/png;base64,iVBORw==');
  assert.equal((await processUpload('q.jpg', bytes('ab')))?.content, 'data:image/jpeg;base64,YWI=');
  assert.equal((await processUpload('q.jpeg', bytes('ab')))?.content, 'data:image/jpeg;base64,YWI=');
  assert.equal((await processUpload('w.webp', bytes('c')))?.content, 'data:image/webp;base64,Yw==');
  assert.equal((await processUpload('g.gif', bytes('d')))?.content, 'data:image/gif;base64,ZA==');
  assert.equal((await processUpload('p.png', bytes('x')))?.content_type, 'image');
});

const csv = async (text: string) => (await processUpload('d.csv', bytes(text)))!;

test('a CSV is previewed as Python dicts, one per line (str(dict)), header row as keys', async () => {
  assert.deepEqual(await csv('a,b\n1,2\n3,4\n'), { name: 'd.csv', content_type: 'csv', size_kb: 1, content: "CSV (2 lignes preview):\n{'a': '1', 'b': '2'}\n{'a': '3', 'b': '4'}" });
});

test('CSV quoting: a quoted comma stays in the field, a doubled quote is one quote, a quoted newline stays', async () => {
  assert.equal((await csv('nom,desc\n"Dupont, J","dit ""oui"""\n')).content, "CSV (1 lignes preview):\n{'nom': 'Dupont, J', 'desc': 'dit \"oui\"'}");
  assert.equal((await csv('a,b\n"l1\nl2",z\n')).content, "CSV (1 lignes preview):\n{'a': 'l1\\nl2', 'b': 'z'}", 'the newline shows as \\n in a Python repr');
});

test('CSV ragged rows follow DictReader: a missing field is None, extra fields go under the key None', async () => {
  assert.equal((await csv('a,b,c\n1,2\n')).content, "CSV (1 lignes preview):\n{'a': '1', 'b': '2', 'c': None}");
  assert.equal((await csv('a,b\n1,2,3,4\n')).content, "CSV (1 lignes preview):\n{'a': '1', 'b': '2', None: ['3', '4']}");
});

test('CSV blank lines are skipped; an empty file and a header-only file have zero rows', async () => {
  assert.equal((await csv('a,b\n\n1,2\n')).content, "CSV (1 lignes preview):\n{'a': '1', 'b': '2'}");
  assert.equal((await csv('')).content, 'CSV (0 lignes preview):\n');
  assert.equal((await csv('a,b\n')).content, 'CSV (0 lignes preview):\n');
});

test('a Python repr picks its quotes and escapes like Python: l\'arbre → "l\'arbre", both kinds → \\\' escaped, backslash doubled', async () => {
  assert.equal((await csv("a\nl'arbre\n")).content, "CSV (1 lignes preview):\n{'a': \"l'arbre\"}");
  assert.equal((await csv('a\nl\'arbre "x"\n')).content, "CSV (1 lignes preview):\n{'a': 'l\\'arbre \"x\"'}");
  assert.equal((await csv('a\nx\\y\n')).content, "CSV (1 lignes preview):\n{'a': 'x\\\\y'}");
  assert.equal((await csv('n\néàü\n')).content, "CSV (1 lignes preview):\n{'n': 'éàü'}", 'accents stay readable (Python 3 repr)');
});

test('non-printable characters are escaped like Python\'s repr (\\t \\xNN \\uNNNN)', async () => {
  assert.equal((await csv('a\n"x\ty"\n')).content, "CSV (1 lignes preview):\n{'a': 'x\\ty'}");
  assert.equal((await csv('a\nx\u0000y\n')).content, "CSV (1 lignes preview):\n{'a': 'x\\x00y'}");
  assert.equal((await csv('a\nx y\n')).content, "CSV (1 lignes preview):\n{'a': 'x\\xa0y'}", 'a no-break space is not printable');
  assert.equal((await csv('a\nx​y\n')).content, "CSV (1 lignes preview):\n{'a': 'x\\u200by'}", 'a zero-width space is not printable');
});

test('a file over the size limit is refused with a message (the original had no limit; without one a huge file freezes the app)', async () => {
  await assert.rejects(processUpload('grand.txt', new Uint8Array(10 * 1024 * 1024 + 1)), /grand\.txt.*10 Mo/);
  assert.ok(await processUpload('limite.txt', new Uint8Array(10 * 1024 * 1024)), 'exactly the limit is accepted');
});

test('a CSV preview stops at 50 rows', async () => {
  const many = 'n\n' + Array.from({ length: 60 }, (_, i) => i).join('\n') + '\n';
  const { content } = await csv(many);
  assert.equal(content.split('\n')[0], 'CSV (50 lignes preview):');
  assert.equal(content.split('\n').length, 51);
});

test('a UTF-8 BOM is not left glued to the first header (a deliberate improvement on Python, where it became part of the key)', async () => {
  assert.equal((await csv('﻿a,b\n1,2\n')).content, "CSV (1 lignes preview):\n{'a': '1', 'b': '2'}");
});

test('the file picker accepts exactly what processUpload supports', () => {
  for (const extension of ['.txt', '.py', '.md', '.pdf', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.json', '.cpp', '.sh']) {
    assert.ok(ACCEPT_ATTRIBUTE.split(',').includes(extension), extension);
  }
  assert.equal(ACCEPT_ATTRIBUTE.split(',').includes('.exe'), false);
});
