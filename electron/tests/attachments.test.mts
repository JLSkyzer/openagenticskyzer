import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageContent, toWireMessage, validateAttachments, type Attachment } from '../core/attachments.mts';

// Expected values below come from the REAL Python `build_message_content` (file_processor.py), run on the same inputs.
const text: Attachment = { name: 'a.txt', content_type: 'text', content: 'AAA', size_kb: 1 };
const csv: Attachment = { name: 'c.csv', content_type: 'csv', content: "CSV (1 lignes preview):\n{'a': '1'}", size_kb: 1 };
const image: Attachment = { name: 'p.png', content_type: 'image', content: 'data:image/png;base64,QQ==', size_kb: 1 };
const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } };

test('buildMessageContent without files is the text itself', () => {
  assert.equal(buildMessageContent('bonjour', []), 'bonjour');
});

test('a file is a "--- name ---" block placed BEFORE the text', () => {
  assert.equal(buildMessageContent('bonjour', [text]), '--- a.txt ---\nAAA\n---\n\nbonjour');
  assert.equal(buildMessageContent('', [text]), '--- a.txt ---\nAAA\n---', 'no trailing blank when there is no text');
  assert.equal(buildMessageContent('q', [text, csv]), "--- a.txt ---\nAAA\n---\n\n--- c.csv ---\nCSV (1 lignes preview):\n{'a': '1'}\n---\n\nq", 'blocks joined by a blank line, in order');
});

test('images become image_url parts first, then ONE text part (list form)', () => {
  assert.deepEqual(buildMessageContent('q', [image]), [imagePart, { type: 'text', text: 'q' }]);
  assert.deepEqual(buildMessageContent('q', [image, text]), [imagePart, { type: 'text', text: '--- a.txt ---\nAAA\n---\n\nq' }], 'a text file goes in the text part');
  assert.deepEqual(buildMessageContent('', [image, text]), [imagePart, { type: 'text', text: '--- a.txt ---\nAAA\n---' }]);
  assert.deepEqual(buildMessageContent('', [image]), [imagePart, { type: 'text', text: '' }], 'the original keeps the (empty) text part');
});

test('toWireMessage expands a user message\'s attachments for the model and never sends the field itself', () => {
  const message = { role: 'user', content: 'q', attachments: [text] };
  assert.deepEqual(toWireMessage(message), { role: 'user', content: '--- a.txt ---\nAAA\n---\n\nq' });
  assert.deepEqual(message, { role: 'user', content: 'q', attachments: [text] }, 'the stored message is not modified');
});

test('toWireMessage leaves every other message exactly as it is', () => {
  const plain = { role: 'user', content: 'salut' };
  assert.deepEqual(toWireMessage(plain), plain);
  assert.deepEqual(toWireMessage({ role: 'user', content: 'salut', attachments: [] }), { role: 'user', content: 'salut' }, 'an empty list is not sent either');
  const assistant = { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] };
  assert.deepEqual(toWireMessage(assistant), assistant);
  const tool = { role: 'tool', tool_call_id: 'c', content: 'sortie' };
  assert.deepEqual(toWireMessage(tool), tool);
});

test('validateAttachments accepts what the renderer produces and returns clean copies', () => {
  const checked = validateAttachments([text, csv, image, { ...text, extra: 'ignored' } as never]);
  assert.equal(checked.length, 4);
  assert.deepEqual(checked[0], text);
  assert.equal('extra' in checked[3], false, 'only the known fields are kept');
  assert.deepEqual(validateAttachments([]), []);
  assert.deepEqual(validateAttachments(undefined), []);
});

test('validateAttachments refuses what is not a list of well-formed attachments', () => {
  for (const bad of ['x', 42, {}, [null], [{}], [{ ...text, name: '' }], [{ ...text, name: 'n'.repeat(256) }], [{ ...text, content_type: 'exe' }],
    [{ ...text, content: 42 }], [{ ...text, size_kb: -1 }], [{ ...text, size_kb: 1.5 }]]) {
    assert.throws(() => validateAttachments(bad), /Pièce jointe invalide|Pièces jointes invalides/, JSON.stringify(bad).slice(0, 60));
  }
});

test('an image must be a DATA URI of a real image type — never a URL the provider would go and fetch', () => {
  const url = (content: string) => [{ ...image, content }];
  for (const good of ['data:image/png;base64,QQ==', 'data:image/jpeg;base64,YWI=', 'data:image/webp;base64,Yw==', 'data:image/gif;base64,ZA==']) {
    assert.doesNotThrow(() => validateAttachments(url(good)), good);
  }
  for (const bad of ['http://169.254.169.254/latest/meta-data', 'https://example.com/a.png', 'file:///C:/secret.png', 'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png,QQ==', 'data:image/png;base64,QQ== extra', 'data:image/png;base64,<script>']) {
    assert.throws(() => validateAttachments(url(bad)), /Pièce jointe invalide/, bad);
  }
});

test('validateAttachments bounds the count and the total size', () => {
  assert.doesNotThrow(() => validateAttachments(Array.from({ length: 20 }, () => text)));
  assert.throws(() => validateAttachments(Array.from({ length: 21 }, () => text)), /Pièces jointes invalides/);
  const big = { ...text, content: 'x'.repeat(16 * 1024 * 1024) };
  assert.throws(() => validateAttachments([big, big]), /Pièces jointes invalides.*volumineuses/);
});

test('toWireMessage also reads a legacy "human" user message', () => {
  assert.deepEqual(toWireMessage({ role: 'human', content: 'q', attachments: [text] }), { role: 'human', content: '--- a.txt ---\nAAA\n---\n\nq' });
});
