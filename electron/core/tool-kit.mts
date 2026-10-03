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

/** Python (pydantic) parity: a model that writes "120" for an integer or "true" for a boolean meant it. */
function coerce(rule: ParamRule, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (rule.type === 'integer' && /^-?\d+$/.test(text)) return Number(text);
  if (rule.type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return value;
}

/** Throws a message that names the field and the rule it broke, so the model can correct its call. */
function checkValue(name: string, rule: ParamRule, value: unknown) {
  if (rule.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${name} doit être un texte`);
    if (value.includes('\0')) throw new Error(`${name} : texte invalide (caractère nul)`);
    const max = rule.maxLength ?? DEFAULT_MAX_LENGTH;
    if (value.length > max) throw new Error(`${name} : texte trop long (${max} caractères au plus)`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`${name} : valeur non autorisée (valeurs possibles : ${rule.enum.join(', ')})`);
  } else if (rule.type === 'integer') {
    const min = rule.minimum ?? DEFAULT_MIN;
    const max = rule.maximum ?? DEFAULT_MAX;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
  } else if (typeof value !== 'boolean') throw new Error(`${name} doit être un booléen (true ou false)`);
}

/**
 * Builds an agent tool whose published schema and argument validation come from the same rules.
 * validate() normalises `args` in place: an undeclared key is dropped (Python parity — the tool still
 * never sees an argument it did not ask for), and a string that clearly is an integer or a boolean is
 * converted; anything else that breaks a rule is refused with the field's name and the rule.
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
      for (const key of Object.keys(args)) if (!Object.hasOwn(spec.properties, key)) delete args[key];
      for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`${key} est requis`);
      for (const [key, value] of Object.entries(args)) {
        const rule = spec.properties[key];
        const coerced = coerce(rule, value);
        checkValue(key, rule, coerced);
        args[key] = coerced;
      }
    },
    execute: async (args, signal) => {
      signal.throwIfAborted();
      return spec.execute(args, signal);
    },
  };
}
