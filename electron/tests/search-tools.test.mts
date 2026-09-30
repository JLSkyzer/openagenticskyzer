import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-search-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const folder = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(folder)]);
  return { home, folder };
}

function tool(tools: any[], name: string) {
  const found = tools.find(t => t.name === name);
  assert.ok(found, `${name} tool must be registered`);
  return found;
}

test('semantic_search returns real ranked results formatted like the original text contract', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  await writeFile(join(folder, 'sort.py'), 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  await writeFile(join(folder, 'weather.py'), 'def get_weather(city):\n    """Fetches the current weather forecast for a city."""\n    return call_weather_api(city)\n');

  const { indexFolder } = await import('../core/semantic-index.mts');
  await indexFolder(folder, home);

  const { searchTools } = await import('../core/search-tools.mts');
  const search = tool(await searchTools(folder, home), 'semantic_search');
  assert.equal(search.category, 'read');

  const output = await search.execute({ query: 'trier une liste' }, new AbortController().signal);
  assert.match(output, /^\[sort\.py\] \(score: 0\.\d\d\)\n/);
  assert.ok(output.includes('\n\n---\n\n'), 'multiple results must be joined by the original separator');
});

test('semantic_search on a folder that was never indexed reports no results, not an error', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  const { searchTools } = await import('../core/search-tools.mts');
  const search = tool(await searchTools(folder, home), 'semantic_search');

  const output = await search.execute({ query: 'anything' }, new AbortController().signal);
  assert.equal(output, 'No results found. The index may not be built yet.');
});

test('knowledge_search returns real ranked results formatted like the original text contract', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  const { addToKnowledge } = await import('../core/knowledge-base.mts');
  await addToKnowledge('recette.txt', 'Pour trier une liste de nombres, on peut utiliser un algorithme de tri rapide.', home);
  await addToKnowledge('meteo.txt', 'Les prévisions météo annoncent de la pluie sur toute la région demain.', home);

  const { searchTools } = await import('../core/search-tools.mts');
  const search = tool(await searchTools(folder, home), 'knowledge_search');
  assert.equal(search.category, 'read');

  const output = await search.execute({ query: 'comment trier une liste' }, new AbortController().signal);
  assert.match(output, /^\[Source: recette\.txt\] \(score: 0\.\d\d\)\n/);
});

test('knowledge_search on an empty knowledge base reports it is empty, not an error', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  const { searchTools } = await import('../core/search-tools.mts');
  const search = tool(await searchTools(folder, home), 'knowledge_search');

  const output = await search.execute({ query: 'anything' }, new AbortController().signal);
  assert.equal(output, 'La base de connaissances est vide ou aucun résultat pertinent.');
});

test('both tools reject a call with no query, and accept a custom n', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  const { searchTools } = await import('../core/search-tools.mts');
  const tools = await searchTools(folder, home);
  for (const name of ['semantic_search', 'knowledge_search']) {
    const search = tool(tools, name);
    assert.throws(() => search.validate({}), /requis/);
    assert.doesNotThrow(() => search.validate({ query: 'x', n: 3 }));
  }
});
