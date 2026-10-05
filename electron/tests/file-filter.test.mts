import { test } from 'node:test';
import assert from 'node:assert/strict';

const { protectedPathMatcher, searchExclusion } = await import('../core/file-filter.mts');

test("protectedPathMatcher refuses .env*, .git and .openagent at any depth and the project's ignored patterns, with either separator", () => {
  const blocked = protectedPathMatcher('node_modules/, dist/, ignored.txt, *.log');
  for (const rel of ['.env', 'sub/.env.local', '.git/config', 'a/.openagent/x.json', 'node_modules/x/index.js', 'dist\\out.js', 'ignored.txt', 'deep/ignored.txt', 'logs/a.log']) {
    assert.equal(blocked(rel), true, rel);
  }
  for (const rel of ['src/app.ts', 'environment.ts', 'dist-notes.md', 'secrets.json']) assert.equal(blocked(rel), false, rel);
});

test('searchExclusion adds key material by name: what no search and no index ever shows', () => {
  const hidden = searchExclusion('private/');
  for (const rel of ['secrets.json', 'conf/credentials.json', 'id_rsa', 'keys/server.pem', 'a.key', 'cert.pfx', 'store.p12', 'private/notes.md', '.env', 'sub\\secrets.json']) {
    assert.equal(hidden(rel), true, rel);
  }
  for (const rel of ['src/secrets.ts', 'README.md', 'public/key.md']) assert.equal(hidden(rel), false, rel);
});
