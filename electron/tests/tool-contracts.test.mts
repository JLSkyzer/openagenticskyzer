// The guard of every change to the tool texts (Task 6): no built-in tool removed, no argument contract changed — the
// contracts were frozen at 377d873, before any text was slimmed (fixtures/tool-contracts.v1.json) — and the slimmed
// texts (the slimToolDefinitions lever) cost fewer tokens than today's, counted as the bench counts them (ruling F2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { builtInTools } from '../core/builtin-tools.mts';
import { REPLACED, SLIM_TOOL_TEXTS, UNSLIMMED_TOOLS, replacesCurrent, slimToolDefinitions } from '../core/tool-texts-slim.mts';
import { defaultToolSchemas, toolDefinitionTokens } from '../bench/tool-tokens.mts';
import { toolContract, type ToolContract } from './support/tool-contract.mts';
import { removeAtEnd } from './teardown.mts';

const frozen: ToolContract[] = JSON.parse(await readFile(new URL('./fixtures/tool-contracts.v1.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

async function tools(t: { after(fn: () => unknown): void }, slim?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-contracts-'));
  removeAtEnd(t, root);
  return builtInTools(root, root, '', slim);
}
const contracts = (list: Awaited<ReturnType<typeof builtInTools>>) => list.map(toolContract).sort((a, b) => a.name.localeCompare(b.name));

test('no tool removed: the same 34 built-in tool names as before the slimming', async t => {
  assert.equal(frozen.length, 34);
  assert.deepEqual(contracts(await tools(t)).map(c => c.name), frozen.map(c => c.name));
});

test('no argument contract weakened: every schema equals the frozen one, descriptions aside — today\'s texts and the slimmed ones', async t => {
  assert.deepEqual(contracts(await tools(t)), frozen);
  assert.deepEqual(contracts(await tools(t, false)), frozen);
  assert.deepEqual(contracts(await tools(t, true)), frozen);
});

test('the slimmed texts: within their limits, aimed at real tools and parameters, and the tool block costs fewer tokens on stories260K', { timeout: 60000 }, async t => {
  const today = await tools(t, false);
  const slim = await tools(t, true);
  for (const [name, texts] of Object.entries(SLIM_TOOL_TEXTS)) {
    const tool = today.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} : aucun outil de ce nom`);
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    for (const param of Object.keys(texts.params ?? {})) assert.ok(Object.hasOwn(properties, param), `${name}.${param} : aucun paramètre de ce nom`);
  }
  for (const tool of slim) {
    assert.ok(tool.description.length > 0 && tool.description.length <= 160, `${tool.name} : description de ${tool.description.length} caractères`);
    for (const [param, rule] of Object.entries((tool.parameters as { properties: Record<string, { description?: string }> }).properties)) {
      assert.ok((rule.description ?? '').length <= 80, `${tool.name}.${param} : description de ${rule.description?.length} caractères`);
    }
  }
  // The modules' own objects (parameter rules shared between tools) are copied, never edited: off stays today's texts.
  const snapshot = JSON.stringify(today);
  slimToolDefinitions(today);
  assert.equal(JSON.stringify(today), snapshot);
  const before = await toolDefinitionTokens(fixture, await defaultToolSchemas(false), false);
  const after = await toolDefinitionTokens(fixture, await defaultToolSchemas(true), true);
  assert.ok(after.tokens < before.tokens, `${after.tokens} jetons avec le levier, ${before.tokens} sans`);
  assert.ok(after.chars < before.chars);
});

test('the slim map is complete and current: every built-in tool is mapped or on the allow-list, and each slim text replaces the module text it was written for', async t => {
  const today = await tools(t, false);
  const names = today.map(tool => tool.name);
  for (const name of names) assert.ok(Object.hasOwn(SLIM_TOOL_TEXTS, name) !== UNSLIMMED_TOOLS.includes(name), `${name} : ni dans SLIM_TOOL_TEXTS ni dans UNSLIMMED_TOOLS (ou dans les deux)`);
  for (const name of UNSLIMMED_TOOLS) assert.ok(names.includes(name), `${name} : aucun outil de ce nom`);
  // Stale-text guard: a module description changed since the slim text was written fails here, by name.
  const keys: string[] = [];
  for (const [name, texts] of Object.entries(SLIM_TOOL_TEXTS)) {
    const tool = today.find(candidate => candidate.name === name)!;
    if (texts.description !== undefined) {
      keys.push(name);
      assert.ok(replacesCurrent(name, tool.description), `${name} : la description du module a changé ; mettre à jour le texte allégé et REPLACED`);
    }
    for (const param of Object.keys(texts.params ?? {})) {
      keys.push(`${name}.${param}`);
      const rule = (tool.parameters as { properties: Record<string, { description?: string }> }).properties[param];
      assert.ok(replacesCurrent(`${name}.${param}`, rule.description), `${name}.${param} : la description du module a changé ; mettre à jour le texte allégé et REPLACED`);
    }
  }
  assert.deepEqual(Object.keys(REPLACED).sort(), keys.sort(), 'REPLACED names exactly the slim texts');
  // And at run time a changed module text is never overridden: the module's newer text goes out.
  const read = today.find(tool => tool.name === 'read_file')!;
  const changed = { ...read, description: 'Texte du module modifié.', parameters: { ...read.parameters, properties: { ...(read.parameters as { properties: object }).properties, path: { type: 'string', description: 'Autre chemin' } } } };
  const [slimmed] = slimToolDefinitions([changed]);
  assert.equal(slimmed.description, 'Texte du module modifié.');
  assert.equal((slimmed.parameters as { properties: Record<string, { description?: string }> }).properties.path.description, 'Autre chemin');
});

test('the lever-off tool block is pinned: today\'s texts and schemas, byte for byte (SHA-256 of the default tool set\'s JSON at 377d873)', async () => {
  const json = JSON.stringify(await defaultToolSchemas(false));
  assert.equal(json.length, 12394);
  assert.equal(createHash('sha256').update(json).digest('hex'), '84a27aa8bb0b649af482666d3f931480c3ffda8dad245cd8e435841777ca498a');
});
