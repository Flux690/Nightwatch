import { describe, expect, it } from "vitest";
import { ELICITATIONS } from "../agent/tools/elicitations.js";
import { TOOL_REGISTRY } from "../agent/tools/toolset.js";
import { SUBMIT_REPORT_TOOL } from "../agent/tools/report.js";
import {
  anthropicToolSchema,
  openAIToolSchema,
} from "../llm/schema-dialects.js";
import type { ToolSchema } from "../llm/types.js";

/* Every schema the build can offer, however it was produced. A hand-written one
   and a generated one answer to the same rules here. */
const SCHEMAS: ToolSchema[] = [
  ...TOOL_REGISTRY.map((tool) => tool.schema),
  ...ELICITATIONS.map((elicitation) => elicitation.schema),
  SUBMIT_REPORT_TOOL.schema,
];

/* Each provider's published list. A keyword outside its own is one that
   provider answers 400 on, breaking every call that offers the tool. */
const DIALECTS = [
  {
    name: "Anthropic",
    reduce: (s: ToolSchema["input_schema"]): unknown => anthropicToolSchema(s),
    allowed: new Set([
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
      "default",
      "minItems",
    ]),
  },
  {
    name: "OpenAI",
    reduce: (s: ToolSchema["input_schema"]): unknown => openAIToolSchema(s),
    allowed: new Set([
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
      "default",
    ]),
  },
];

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every nested schema, so a rule holds at depth rather than only at the root.
function walk(node: unknown, path: string, into: Array<[string, Node]>): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, into));
    return;
  }
  if (!isNode(node)) return;
  into.push([path, node]);
  for (const [key, value] of Object.entries(node)) {
    walk(value, path === "" ? key : `${path}.${key}`, into);
  }
}

function nodesOf(schema: unknown, name: string): Array<[string, Node]> {
  const into: Array<[string, Node]> = [];
  walk(schema, name, into);
  return into;
}

// Every declared property, with the path a failure names it by.
function propertiesOf(schema: ToolSchema): Array<[string, Node]> {
  const into: Array<[string, Node]> = [];
  for (const [path, node] of nodesOf(schema.input_schema, schema.name)) {
    const properties = node["properties"];
    if (!isNode(properties)) continue;
    for (const [name, property] of Object.entries(properties)) {
      if (isNode(property)) into.push([`${path}.${name}`, property]);
    }
  }
  return into;
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

// A limit is met either as a numeral or spelled out, because "at least one"
// reads better in a sentence than "at least 1".
function states(description: string, value: unknown): boolean {
  if (typeof value !== "number") return false;
  if (description.includes(String(value))) return true;
  const word = WORDS[value];
  return (
    word !== undefined && new RegExp(`\\b${word}\\b`, "i").test(description)
  );
}

const BOUNDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "maxLength",
] as const;

// Zod stamps the safe-integer range onto every .int(). Nobody authored it, and
// no description should have to recite it.
function isAuthored(value: unknown): boolean {
  return value !== Number.MAX_SAFE_INTEGER && value !== Number.MIN_SAFE_INTEGER;
}

describe("every tool schema is one a provider will accept", () => {
  it("offers at least one schema, so the sweeps below cannot pass vacuously", () => {
    expect(SCHEMAS.length).toBeGreaterThan(30);
  });

  describe.each(DIALECTS)("reduced for $name", ({ reduce, allowed }) => {
    it("carries no keyword outside this provider's list, at any depth", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          // A properties map's keys are field names, not keywords.
          if (
            path.endsWith(".properties") ||
            path === `${schema.name}.properties`
          ) {
            continue;
          }
          for (const keyword of Object.keys(node)) {
            expect(allowed.has(keyword), `${path} carries ${keyword}`).toBe(
              true,
            );
          }
        }
      }
    });

    // Rejected outright by OpenAI, and silently permissive on Anthropic.
    it("closes every object, not only the root", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          if (node["type"] !== "object") continue;
          expect(node["additionalProperties"], `${path} is open`).toBe(false);
        }
      }
    });

    // Strict needs the key present even when nothing is required.
    it("declares required on every object, empty where nothing is", () => {
      for (const schema of SCHEMAS) {
        for (const [path, node] of nodesOf(
          reduce(schema.input_schema),
          schema.name,
        )) {
          if (node["type"] !== "object") continue;
          expect(Array.isArray(node["required"]), `${path} omits it`).toBe(
            true,
          );
        }
      }
    });
  });

  it("describes every property, so none reaches the model unnamed", () => {
    for (const schema of SCHEMAS) {
      for (const [path, property] of propertiesOf(schema)) {
        expect(
          typeof property["description"],
          `${path} carries no description`,
        ).toBe("string");
      }
    }
  });

  /* A reducer deletes most bounds, so a limit reaches the model as prose alone.
     Stated always: which provider runs is unknown when the description is written. */
  it("states every bound in the description of the field carrying it", () => {
    for (const schema of SCHEMAS) {
      for (const [path, property] of propertiesOf(schema)) {
        const description = property["description"];
        if (typeof description !== "string") continue;
        if (property["type"] === "integer") {
          expect(
            /whole number|integer/i.test(description),
            `${path} is an integer and does not say so`,
          ).toBe(true);
        }
        for (const bound of BOUNDS) {
          if (property[bound] === undefined) continue;
          if (!isAuthored(property[bound])) continue;
          expect(
            states(description, property[bound]),
            `${path} bounds ${bound} at ${String(property[bound])} without saying so`,
          ).toBe(true);
        }
        // minLength 1 is exempt: `required` already says the field needs content.
        if (
          property["minLength"] !== undefined &&
          property["minLength"] !== 1
        ) {
          expect(
            states(description, property["minLength"]),
            `${path} bounds minLength without saying so`,
          ).toBe(true);
        }
      }
    }
  });

  // A generated schema takes its property order from the Zod object, so a
  // reorder there silently reorders what the model is asked for.
  it("asks RecordHypothesis for its reasoning before its verdict", () => {
    const record = SCHEMAS.find((s) => s.name === "RecordHypothesis");
    const order = Object.keys(record?.input_schema.properties ?? {});
    expect(order.indexOf("finding")).toBeGreaterThan(-1);
    expect(order.indexOf("finding")).toBeLessThan(order.indexOf("verdict"));
    expect(order.indexOf("evidenceIds")).toBeLessThan(order.indexOf("verdict"));
  });

  it("declares every required name as a property of the same object", () => {
    for (const schema of SCHEMAS) {
      for (const [path, node] of nodesOf(schema.input_schema, schema.name)) {
        const required = node["required"];
        if (!Array.isArray(required)) continue;
        const properties = isNode(node["properties"]) ? node["properties"] : {};
        for (const name of required) {
          expect(
            Object.keys(properties),
            `${path} requires ${String(name)}`,
          ).toContain(name);
        }
      }
    }
  });
});
