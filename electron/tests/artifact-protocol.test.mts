import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createArtifactStore, cspFor, SCHEME } = require('../artifact-protocol.cjs');

test('put stores a document and answers the oa-artifact: URL that serves it', () => {
  const store = createArtifactStore();
  const { url } = store.put('html', '<p>salut</p>');
  assert.match(url, new RegExp(`^${SCHEME}://a/[0-9a-f-]{36}$`));
  const reply = store.respond(url, 'GET');
  assert.equal(reply.status, 200);
  assert.equal(reply.body, '<p>salut</p>');
  assert.match(reply.headers['content-type'], /^text\/html; charset=utf-8/);
});

test('an html artifact may run its inline script, but the page it is served with can reach NOTHING on the network', () => {
  const policy = cspFor('html');
  assert.match(policy, /default-src 'none'/, 'everything not listed is forbidden — connect-src (fetch, XHR, WebSocket), frames, forms…');
  assert.match(policy, /script-src 'unsafe-inline'/);
  assert.match(policy, /style-src 'unsafe-inline'/);
  assert.match(policy, /img-src data: blob:/);
  assert.doesNotMatch(policy, /connect-src|https?:|\*/, 'no network source of any kind');
});

test('a static artifact (svg, mermaid) gets a policy with no script at all', () => {
  const policy = cspFor('static');
  assert.match(policy, /default-src 'none'/);
  assert.doesNotMatch(policy, /script-src/, 'script falls back to default-src: none');
  assert.doesNotMatch(policy, /connect-src|https?:|\*/);
});

test('the policy is sent as a header with every document, matching the kind it was stored with', () => {
  const store = createArtifactStore();
  const html = store.respond(store.put('html', 'a').url, 'GET');
  const fixed = store.respond(store.put('static', 'b').url, 'GET');
  assert.equal(html.headers['content-security-policy'], cspFor('html'));
  assert.equal(fixed.headers['content-security-policy'], cspFor('static'));
  assert.equal(html.headers['x-content-type-options'], 'nosniff');
});

test('put refuses an unknown kind, a non-string document and a document over the size limit', () => {
  const store = createArtifactStore({ maxBytes: 100 });
  assert.throws(() => store.put('script', 'x'), /Type d’artifact invalide/);
  assert.throws(() => store.put('html', 42 as never), /Contenu d’artifact invalide/);
  assert.throws(() => store.put('html', 'x'.repeat(101)), /trop volumineux/);
  assert.doesNotThrow(() => store.put('html', 'x'.repeat(100)));
});

test('size is counted in bytes, not characters', () => {
  const store = createArtifactStore({ maxBytes: 10 });
  assert.throws(() => store.put('html', 'é'.repeat(6)), /trop volumineux/, '6 characters but 12 bytes');
});

test('the store keeps only the most recent documents: the oldest is forgotten', () => {
  const store = createArtifactStore({ max: 2 });
  const first = store.put('html', '1').url;
  const second = store.put('html', '2').url;
  const third = store.put('html', '3').url;
  assert.equal(store.respond(first, 'GET').status, 404);
  assert.equal(store.respond(second, 'GET').body, '2');
  assert.equal(store.respond(third, 'GET').body, '3');
});

test('anything but GET on a known document, and any unknown or malformed URL, is refused without leaking why', () => {
  const store = createArtifactStore();
  const { url } = store.put('html', 'secret');
  assert.equal(store.respond(url, 'POST').status, 405);
  assert.equal(store.respond(`${SCHEME}://a/00000000-0000-0000-0000-000000000000`, 'GET').status, 404);
  assert.equal(store.respond(`${SCHEME}://a/../../etc/passwd`, 'GET').status, 404);
  assert.equal(store.respond(`${SCHEME}://other/${url.split('/').pop()}`, 'GET').status, 404, 'only the fixed host');
  assert.equal(store.respond('not a url', 'GET').status, 404);
  assert.doesNotMatch(String(store.respond(`${SCHEME}://a/x`, 'GET').body), /secret/);
});
