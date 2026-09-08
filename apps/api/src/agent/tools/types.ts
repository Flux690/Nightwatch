import type { z } from "zod";
import type { EvidenceKind, Platform } from "@nightwarden/shared";
import type { ToolSchema } from "../../llm/types.js";

export interface ToolExecuteResult {
  // A structured value where the tool has one, so a caller can ask what it
  // found rather than reading it back out of prose.
  content: unknown;
  isError?: true;
}

// What the dispatcher hands back: the result already rendered to the string the
// model reads, and already bounded, so no caller can enter context past the cap.
export interface DispatchedToolResult {
  content: string;
  isError?: true;
}

interface ToolCallIdentity {
  // Session-scoped: repo tools key their sandbox workspace on it. Tools stay
  // stateless; the sandbox module owns all bookkeeping.
  sessionId: string;
  // The tool_use id of this call: OpenPullRequest keys its write-ahead audit row on
  // (sessionId, toolCallId), the same idempotency the approval path uses.
  toolCallId: string;
}

// What a caller hands the dispatcher: the upper bound this call may not exceed,
// being the user's ceiling already clamped by what remains of the run.
export interface ToolDispatchContext extends ToolCallIdentity {
  toolCallCeilingMs: number;
}

// What a tool is handed: the limit resolved for this one call. Distinct from
// the ceiling above so neither can be mistaken for the other.
export interface ToolExecuteContext extends ToolCallIdentity {
  toolTimeoutMs: number;
  // The same limit as a signal, for a call that reaches the network. Required,
  // so a client that forgets to bound its request will not compile.
  signal: AbortSignal;
}

// Two facts, not one: a write can be safe for where it lands, so a tool that
// overrides the write -> approve default says why on its entry.
export type ToolPolicy = "auto" | "approve";

interface ToolCommon {
  schema: ToolSchema;
  // The same object the schema was generated from. executeTool parses with it
  // before dispatch, so no handler validates its own arguments.
  input: z.ZodObject;
  effect: "read" | "write";
  policy: ToolPolicy;
  // A write safe to run twice, which is what lets a call caught by a crash be
  // replayed instead of unwound. Only ever true where the tool says why.
  idempotent?: true;
  // Per-tool override of the global tool timeout: repo tools run clones,
  // installs and test suites, which dwarf the 15s default.
  timeoutMs?: number;
}

/* Whether a claim may rest on this call, and how its result draws. One decision
   rather than two: a call that observes nothing has no renderer to declare. */
export type Citability =
  { citable: false } | { citable: true; renderAs: EvidenceKind };

// Where a tool executes is declared, never inferred. A service-routed command
// finds its owner from the target key; a server-routed one names its platform.
export type Tool = ToolCommon &
  Citability &
  (
    | {
        on: "api";
        /* A property, not a method: shorthand is bivariant and would accept a
           handler typed to another tool's schema. `apiTool` is the only way in. */
        execute: (
          input: unknown,
          ctx: ToolExecuteContext,
        ) => Promise<ToolExecuteResult>;
      }
    | { on: "runner"; routeBy: "service" }
    | { on: "runner"; routeBy: "server"; platform: Platform }
  );
