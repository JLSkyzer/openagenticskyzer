import type { AgentTool } from './agent.mts';
import { object } from './json-store.mts';

/** The JSON-Schema subset the agent tools use: it is both what the model is shown and what is enforced. */
export interface ParamRule {
  type: 'string' | 'integer' | 'boolean';
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}
export interface ToolSpec {
  name: string;
  description: string;
  category: AgentTool['category'];
  properties: Record<string, ParamRule>;
  required?: string[];
  execute: AgentTool['execute'];
}

const DEFAULT_MAX_LENGTH = 1048576;
const DEFAULT_MIN = 1;
const DEFAULT_MAX = 1000000;

function checkValue(rule: ParamRule, value: unknown) {
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > (rule.maxLength ?? DEFAULT_MAX_LENGTH) || value.includes('\0')) throw new Error('Texte invalide');
    if (rule.enum && !rule.enum.includes(value)) throw new Error('Valeur non autorisée');
  } else if (rule.type === 'integer') {
    if (!Number.isInteger(value) || Number(value) < (rule.minimum ?? DEFAULT_MIN) || Number(value) > (rule.maximum ?? DEFAULT_MAX)) throw new Error('Nombre invalide');
  } else if (typeof value !== 'boolean') throw new Error('Booléen invalide');
}

/**
 * Builds an agent tool whose published schema and argument validation come from the same
 * rules. Anything not declared is refused, so a tool never sees an argument it did not ask for.
 */
export function defineTool(spec: ToolSpec): AgentTool {
  const required = spec.required ?? [];
  for (const rule of Object.values(spec.properties)) {
    if (!['string', 'integer', 'boolean'].includes(rule.type)) throw new Error('Type de paramètre non supporté');
  }
  return {
    name: spec.name,
    description: spec.description,
    category: spec.category,
    parameters: { type: 'object', properties: spec.properties, required, additionalProperties: false },
    validate(args) {
      object(args);
      for (const key of required) if (!Object.hasOwn(args, key)) throw new Error('Argument requis');
      for (const [key, value] of Object.entries(args)) {
        const rule = Object.hasOwn(spec.properties, key) ? spec.properties[key] : undefined;
        if (!rule) throw new Error('Argument inconnu');
        checkValue(rule, value);
      }
    },
    execute: async (args, signal) => {
      signal.throwIfAborted();
      return spec.execute(args, signal);
    },
  };
}
