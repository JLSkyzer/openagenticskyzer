// Local-only models: the production code holds no HTTP model client and never reaches the test seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const electron = fileURLToPath(new URL('..', import.meta.url));

async function walk(dir: string, extensions: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path, extensions));
    else if (extensions.test(entry.name)) found.push(path);
  }
  return found;
}

/** The production files: core/**, the worker, the main process and its helpers, the renderer's sources. tests/**,
 * scripts/** and docs/** are not production code. */
async function productionSources(): Promise<Map<string, string>> {
  const files = [
    ...await walk(join(electron, 'core'), /\.(mts|cjs|ts)$/),
    ...['worker.mjs', 'main.cjs', 'preload.cjs', 'artifact-protocol.cjs', 'tray-icon.cjs', 'updater.cjs'].map(name => join(electron, name)),
    ...await walk(join(electron, 'renderer-src', 'src'), /\.(ts|tsx)$/),
  ];
  const sources = new Map<string, string>();
  for (const file of files) sources.set(relative(electron, file), await readFile(file, 'utf8'));
  return sources;
}

test('no production module imports the HTTP model client or the test seam', async () => {
  const production = await productionSources();
  assert.ok(production.has('worker.mjs') && production.has(join('core', 'agent.mts')) && production.size > 50, `the scan found the production files (${production.size})`);
  for (const [file, source] of production) {
    assert.doesNotMatch(source, /[/'"]provider\.mts['"]/, file); // core/provider.mts (local-provider.mts is not matched)
    assert.doesNotMatch(source, /test-model-provider|tests[\\/]support/, file);
    assert.doesNotMatch(source, /\bclass ChatProvider\b|\bnew ChatProvider\(/, file); // the renderer's React ChatProvider component is a function
  }
});

// Online MODEL-PROVIDER hosts only. The spec names `api.openrouter`; the real hosts are listed too, since the app's URL
// was `openrouter.ai/api`. Never tavily, duckduckgo or huggingface.co: the web tools (core/web-tools.mts) and the
// Hugging Face token check (core/hf-token.mts) are kept.
const ONLINE_MODEL_HOSTS = ['api.openrouter', 'openrouter.ai', 'api.together.xyz', 'api.groq.com', 'api.mistral.ai', 'generativelanguage.googleapis.com'];

test('no production module names an online model service', async () => {
  const production = await productionSources();
  assert.ok(production.has(join('core', 'web-tools.mts')) && production.has(join('core', 'hf-token.mts')), 'the kept web tools and HF check are scanned too');
  for (const [file, source] of production) {
    const lower = source.toLowerCase();
    for (const host of ONLINE_MODEL_HOSTS) assert.equal(lower.includes(host), false, `${file} names ${host}`);
  }
});

test('the data-folder migration no longer knows the vault', async () => {
  for (const file of [join('core', 'data-dir.mts'), join('core', 'data-home.cjs')]) {
    assert.equal((await readFile(join(electron, file), 'utf8')).toLowerCase().includes('connections'), false, `${file} names « connections »`);
  }
});
