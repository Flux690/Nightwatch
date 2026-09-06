import { z } from "zod";
import type { EvidenceKind, ToolName } from "@nightwarden/shared";
import type { ToolSchema } from "../../llm/types.js";
import type {
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolPolicy,
} from "./types.js";

type InputSchema = ToolSchema["input_schema"];

/* One idiom for absence: an optional string arrives trimmed, and a blank one
   arrives absent, so no handler tests for an empty string. */
export const optionalText = z
  .string()
  .optional()
  .transform((raw) => {
    const trimmed = raw?.trim();
    return trimmed === "" ? undefined : trimmed;
  });

/* Names the Zod object once: the tool carries it for executeTool to parse with,
   and the schema the model reads is generated from the same one. */
export function declareTool<T extends z.ZodObject>(
  name: ToolName,
  description: string,
  input: T,
): { schema: ToolSchema; input: T } {
  return { schema: toolSchema(name, description, input), input };
}

/* Emits the whole schema, keywords and all. Which of them a provider's grammar
   accepts is that provider's business, decided by the reducers in llm/. */
export function toolSchema(
  name: ToolName,
  description: string,
  input: z.ZodObject,
): ToolSchema {
  const generated = z.toJSONSchema(input, { io: "input" });
  delete generated["$schema"];
  // A z.object always yields an object schema, which the test asserts across
  // every tool in the build.
  return { name, description, input_schema: generated as InputSchema };
}

interface ApiToolSpec<T extends z.ZodObject> {
  name: ToolName;
  description: string;
  input: T;
  effect: "read" | "write";
  policy: ToolPolicy;
  evidenceKind: EvidenceKind;
  idempotent?: true;
  timeoutMs?: number;
  // A property for the reason the registry's is: shorthand would not check it.
  execute: (
    input: z.infer<T>,
    ctx: ToolExecuteContext,
  ) => Promise<ToolExecuteResult>;
}

/* Binds a handler to the Zod object its own schema was generated from, so a
   handler cannot declare a shape the tool does not carry. */
export function apiTool<T extends z.ZodObject>(spec: ApiToolSpec<T>): Tool {
  const { name, description, input, execute, ...rest } = spec;
  return {
    ...rest,
    schema: toolSchema(name, description, input),
    input,
    on: "api",
    /* The single place the bound handler meets the loose registry: T is fixed
       above for both fields at once, which the registry's type cannot express. */
    execute: execute as Extract<Tool, { on: "api" }>["execute"],
  };
}

// Named fields, because "invalid input" leaves the model nothing to correct.
function fieldErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

// The failure narrows content to a string, since the turn renders it directly.
interface ParseFailure extends ToolExecuteResult {
  content: string;
}

type Parsed =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; failure: ParseFailure };

/* The harness rejecting an argument is the harness breaking, not a finding, so
   it carries the system class rather than reading as an answer. */
export function parseInput(schema: z.ZodObject, input: unknown): Parsed {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    failure: {
      content: `That call could not be made - ${fieldErrors(parsed.error)}. Correct the arguments against the tool's description and call it again.`,
      isError: true,
    },
  };
}
