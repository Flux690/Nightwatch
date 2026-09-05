import type { ToolSchema } from "./types.js";

/* What each provider's strict mode accepts, from its own published list. The
   two sit together because they differ in exactly two keywords. */

// Structural keywords both providers document as supported.
const SHARED = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "description",
  "enum",
  "const",
  "anyOf",
  "$ref",
  "$defs",
  /* Kept for OpenAI too, where strict mode requires every field: a defaulted
     one arrives nullable, and this is what says which value to send. */
  "default",
] as const;

// Anthropic documents minItems at 0 and 1; OpenAI's strict mode refuses it.
const ANTHROPIC = new Set<string>([...SHARED, "minItems"]);
const OPENAI = new Set<string>(SHARED);

/* `format` is on neither list: Anthropic accepts only a named set of values, so
   letting the keyword through would let an unaccepted value through with it. */

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* Copies rather than edits: one generated schema is read by whichever provider
   the run picks, so a reducer that mutated would reduce it for the other too. */
function reduce(node: unknown, allowed: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => reduce(item, allowed));
  if (!isNode(node)) return node;
  const out: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (!allowed.has(key)) continue;
    // Anthropic expresses this one length constraint, and only at these values.
    if (key === "minItems" && value !== 0 && value !== 1) continue;
    out[key] =
      key === "properties"
        ? reduceProperties(value, allowed)
        : reduce(value, allowed);
  }
  if (out["type"] === "object") {
    // Both providers require it on every object rather than only the root.
    out["additionalProperties"] = false;
    // Zod omits an empty one; strict needs the key present whatever it holds.
    out["required"] ??= [];
  }
  return out;
}

// Property names are data, so they are carried through rather than filtered.
function reduceProperties(value: unknown, allowed: Set<string>): unknown {
  if (!isNode(value)) return reduce(value, allowed);
  const out: Node = {};
  for (const [name, property] of Object.entries(value)) {
    out[name] = reduce(property, allowed);
  }
  return out;
}

type InputSchema = ToolSchema["input_schema"];

export function anthropicToolSchema(schema: InputSchema): InputSchema {
  // A z.object always reduces to an object schema, which tool-schema.test.ts
  // asserts across every tool in the build.
  return reduce(schema, ANTHROPIC) as InputSchema;
}

/* Strict mode requires every property in `required`, an optional one typed as
   a union with null. Anthropic has no such rule, so the schemas are bent here. */
export function openAIToolSchema(schema: InputSchema): Record<string, unknown> {
  const widen = (value: unknown): unknown => {
    if (!isNode(value)) return value;
    const shape: Node = { ...value };
    if (shape["type"] === "object") return widenObject(shape);
    if (shape["type"] === "array" && shape["items"] !== undefined) {
      shape["items"] = widen(shape["items"]);
    }
    return shape;
  };

  const widenObject = (object: Node): Node => {
    const properties = (object["properties"] ?? {}) as Node;
    const required = new Set((object["required"] ?? []) as string[]);
    const widened: Node = {};
    for (const [name, property] of Object.entries(properties)) {
      const mapped = widen(property) as Node;
      widened[name] =
        required.has(name) || typeof mapped["type"] !== "string"
          ? mapped
          : { ...mapped, type: [mapped["type"], "null"] };
    }
    return {
      ...object,
      properties: widened,
      required: Object.keys(widened),
      additionalProperties: false,
    };
  };

  return widenObject(reduce(schema, OPENAI) as Node);
}
