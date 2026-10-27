// The guard of every change to the tool texts (Task 6): no built-in tool removed, no argument contract changed — the
// contracts were frozen at 377d873, before any text was slimmed (fixtures/tool-contracts.v1.json) — and the slimmed
// texts (the slimToolDefinitions lever) cost fewer tokens than today's, counted as the bench counts them (ruling F2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtInTools } from '../core/builtin-tools.mts';
import { SLIM_TOOL_TEXTS, slimToolDefinitions } from '../core/tool-texts-slim.mts';
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
