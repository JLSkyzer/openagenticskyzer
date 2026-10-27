// A built-in tool's argument contract, descriptions aside: what the model may send and what the tool accepts. The
// tool-contract guard (tests/tool-contracts.test.mts) compares it with the contracts frozen before the tool texts were
// slimmed (fixtures/tool-contracts.v1.json), so a shorter text can never come with a looser schema.
import type { AgentTool } from '../../core/agent.mts';

export type PropertyContract = { [key: string]: unknown };

export interface ToolContract {
  name: string;
  category: AgentTool['category'];
  /** Sorted; a missing `required` is []. */
  required: string[];
  additionalProperties: unknown;
  properties: Record<string, PropertyContract>;
}

/** Every schema key but `description`, recursively (`items`, nested `properties`, `enum`, limits, `default`…). */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) if (key !== 'description') kept[key] = withoutDescriptions(inner);
  return kept;
}

export function toolContract(tool: AgentTool): ToolContract {
  const parameters = tool.parameters as { required?: string[]; additionalProperties?: unknown; properties?: Record<string, unknown> };
  const properties: Record<string, PropertyContract> = {};
  for (const [name, rule] of Object.entries(parameters.properties ?? {})) properties[name] = withoutDescriptions(rule) as PropertyContract;
  return {
    name: tool.name,
    category: tool.category,
    required: [...(parameters.required ?? [])].sort(),
    additionalProperties: parameters.additionalProperties,
    properties,
  };
}
