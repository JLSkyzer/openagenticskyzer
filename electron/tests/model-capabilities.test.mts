// Can a chat template call tools? Each fixture is a real template, with the value the probe of node-llama-cpp gave it
// (2026-11-09, node-llama-cpp 3.21.1): the expected value is what the library does, not what the template's text says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolSupportOf, type ToolSupport } from '../core/model-capabilities.mts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/chat-templates.json', import.meta.url), 'utf8')) as { id: string; wrapper: string; expected: ToolSupport; template: string }[];

test('the fixtures cover the three answers', () => {
  assert.deepEqual([...new Set(fixtures.map(fixture => fixture.expected))].sort(), ['no', 'unknown', 'yes']);
});

for (const fixture of fixtures) {
  test(`toolSupportOf: ${fixture.id} → ${fixture.expected}`, () => {
    assert.equal(toolSupportOf(fixture.template), fixture.expected, fixture.wrapper);
  });
}

test('toolSupportOf: a template that never mentions tools is not a « no » by itself', () => {
  const noMention = fixtures.filter(fixture => !/tool/i.test(fixture.template));
  assert.ok(noMention.length >= 2, 'the fixtures hold templates without any tool mention');
  for (const fixture of noMention) assert.equal(toolSupportOf(fixture.template), 'yes', fixture.id);
});

test('toolSupportOf: no template at all → unknown', () => {
  assert.equal(toolSupportOf(undefined), 'unknown');
  assert.equal(toolSupportOf(null), 'unknown');
  assert.equal(toolSupportOf(''), 'unknown');
  assert.equal(toolSupportOf('  \n '), 'unknown');
});

test('toolSupportOf: a value that is not a string, as remote JSON can hold → unknown, not a throw', () => {
  assert.equal(toolSupportOf([{ name: 'default', template: 'x' }] as unknown as string), 'unknown');
});

test('toolSupportOf: a template that makes the resolution throw → unknown, not a throw', () => {
  // The ChatML marker matters: left to its fallback, the resolution would guess ChatML from this text and answer « yes ».
  assert.equal(toolSupportOf("{% if %}<|im_start|>{{ message['content'] }}<|im_end|>"), 'unknown');
});
