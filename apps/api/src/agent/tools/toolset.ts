import { executeRunnerTool } from "../executor.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_CHARS,
} from "../../llm/config.js";
import { DOCKER_TOOLS } from "./docker.js";
import { ELICITATIONS, type Elicitation } from "./elicitations.js";
import { GITHUB_TOOLS } from "./github.js";
import { HOST_TOOLS } from "./host.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { LOKI_TOOLS } from "./loki.js";
import { METRICS_TOOLS } from "./metrics.js";
import { REPO_TOOLS } from "./repo.js";
import { REPORT_TOOLS } from "./report.js";
import type {
  DispatchedToolResult,
  Tool,
  ToolDispatchContext,
  ToolExecuteContext,
  ToolPolicy,
} from "./types.js";
import type { ToolSchema } from "../../llm/types.js";
import type { Platform } from "@nightwarden/shared";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...DOCKER_TOOLS,
  ...HOST_TOOLS,
  ...K8S_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
  ...METRICS_TOOLS,
  ...LOKI_TOOLS,
  ...REPORT_TOOLS,
];

/* The citation handle, put where the model reads it. The provider's own call id
   lives in the message's tool_calls plumbing and never appears as content, which
   is why a run asked to cite one invented 21 ids rather than copy a real one.

   A field on the object rather than a prefix on the text: most results are JSON
   and the console parses them, so a header line would break every tool card and
   the report's evidence renderers. A plain-string result takes the prefix, since
   nothing parses those. */
function withEvidenceId(
  content: unknown,
  evidenceId: string | undefined,
): string {
  if (evidenceId === undefined) {
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  if (typeof content === "string") return `[${evidenceId}] ${content}`;
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content)
  ) {
    return JSON.stringify({ evidenceId, ...content });
  }
  return JSON.stringify({ evidenceId, result: content });
}

// Refused whole rather than shortened: a sliced JSON result parses as a smaller
// truth, which is how an agent reports no errors in logs it never saw.
function tooLarge(name: string, chars: number): string {
  return `${name} produced ${chars} characters, past the ${MAX_TOOL_RESULT_CHARS} a single result may occupy, so none of it was read. Narrow the call - a tighter filter, a shorter window, a smaller limit - and run it again.`;
}

// Single dispatch chokepoint that both the live loop and the approval resume
// path pass through. The caller supplies a ceiling; a tool's own limit can only
// narrow it, never raise it past what the user allowed.
export async function executeTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<DispatchedToolResult> {
  const { toolCallCeilingMs, ...identity } = ctx;
  const effectiveCtx: ToolExecuteContext = {
    ...identity,
    toolTimeoutMs: Math.min(
      tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      toolCallCeilingMs,
    ),
  };
  const result =
    tool.on === "api"
      ? await tool.execute(input, effectiveCtx)
      : await executeRunnerTool(tool, input, effectiveCtx);
  const content = withEvidenceId(result.content, ctx.evidenceId);
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    return {
      content: tooLarge(tool.schema.name, content.length),
      toolOutcome: "system",
    };
  }
  return {
    content,
    ...(result.toolOutcome !== undefined && {
      toolOutcome: result.toolOutcome,
    }),
  };
}

// The single resolver used by both the loop and human-input (resuming a stored
// interrupt); names are stable, so there is no legacy fallback.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

/* Whether a human must permit this call. A function rather than a field read
   because a user rule will answer from the arguments as well as the tool,
   and `input` is already here for it. */
export function resolvePolicy(
  tool: Tool,
  _input: Record<string, unknown>,
): ToolPolicy {
  return tool.policy;
}

// Which pull-integrations are connected this turn. Each defaults to true so a
// caller that only cares about platforms still gets every library; the loop passes
// live state, so a disconnected integration strips its tools from the next turn.
interface IntegrationConnections {
  github?: boolean;
  metrics?: boolean;
  loki?: boolean;
}

// What one turn offers: the things that execute, and the one thing only a
// person can answer. Assembled together so hiding and gating stay one op.
export interface OfferedToolset {
  tools: Tool[];
  elicitations: Elicitation[];
}

// Single source of truth for both the offered schemas and the names the loop
// resolves, so hiding a tool and gating it are one op. `platforms` undefined means
// every library, which only a caller wanting the whole catalogue passes.
export function effectiveToolset(
  platforms: Set<Platform> | undefined,
  connections: IntegrationConnections = {},
  investigation = true,
): OfferedToolset {
  const { github = true, metrics = true, loki = true } = connections;
  const has = (platform: Platform): boolean =>
    platforms === undefined || platforms.has(platform);
  return {
    tools: [
      // Host tools ride with Docker: they gate on the platform, since host facts
      // only mean something on a runner that is 1:1 with its machine.
      ...(has("docker") ? [...DOCKER_TOOLS, ...HOST_TOOLS] : []),
      ...(has("kubernetes") ? K8S_TOOLS : []),
      ...(github ? [...REPO_TOOLS, ...GITHUB_TOOLS] : []),
      ...(metrics ? METRICS_TOOLS : []),
      ...(loki ? LOKI_TOOLS : []),
      // The record is the investigation's, so a chat is offered no way to write
      // one. What a session is was decided before the run started.
      ...(investigation ? REPORT_TOOLS : []),
    ],
    // Never stripped: a question needs no integration and no runner to reach a
    // human, so every session can ask one.
    elicitations: ELICITATIONS,
  };
}

// The wire shape of everything on offer, in the order the model is shown it.
export function offeredSchemas(offered: OfferedToolset): ToolSchema[] {
  return [
    ...offered.tools.map((t) => t.schema),
    ...offered.elicitations.map((e) => e.schema),
  ];
}

// Schemas only, for callers that just need the wire shape (e.g. tests); the loop uses
// effectiveToolset directly.
export function getToolSchemas(
  platforms?: Set<Platform>,
  connections?: IntegrationConnections,
): ToolSchema[] {
  return offeredSchemas(effectiveToolset(platforms, connections ?? {}));
}
