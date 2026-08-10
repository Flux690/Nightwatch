import { executeRunnerTool } from "../executor.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_CHARS,
} from "../../llm/config.js";
import { DOCKER_TOOLS } from "./docker.js";
import { GITHUB_TOOLS } from "./github.js";
import { HOST_TOOLS } from "./host.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { INTERRUPT_TOOLS } from "./interrupts.js";
import { LOKI_TOOLS } from "./loki.js";
import { PROMETHEUS_TOOLS } from "./prometheus.js";
import { REPO_TOOLS } from "./repo.js";
import { REPORT_TOOLS } from "./report.js";
import type {
  DispatchedToolResult,
  Tool,
  ToolDispatchContext,
  ToolExecuteContext,
} from "./types.js";
import type { ToolSchema } from "../../llm/types.js";
import type { Platform } from "@nightwarden/shared";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...DOCKER_TOOLS,
  ...HOST_TOOLS,
  ...K8S_TOOLS,
  ...INTERRUPT_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
  ...PROMETHEUS_TOOLS,
  ...LOKI_TOOLS,
  ...REPORT_TOOLS,
];

// Refused whole rather than shortened: a sliced JSON result parses as a smaller
// truth, which is how an agent reports no errors in logs it never saw.
function tooLarge(name: string, chars: number): string {
  return `${name} produced ${chars} characters, past the ${MAX_TOOL_RESULT_CHARS} a single result may occupy, so none of it was read. Narrow the call - a tighter filter, a shorter window, a smaller limit - and run it again.`;
}

// Single dispatch chokepoint that both the live loop and the approval resume
// path pass through. The caller supplies a ceiling; a tool's own limit can only
// narrow it, never raise it past what the operator allowed.
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
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    return {
      content: tooLarge(tool.schema.name, content.length),
      outcome: "system",
    };
  }
  return {
    content,
    ...(result.outcome !== undefined && { outcome: result.outcome }),
  };
}

// The single resolver used by both the loop and human-input (resuming a stored
// interrupt); names are stable, so there is no legacy fallback.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

// Which pull-integrations are connected this turn. Each defaults to true so a
// caller that only cares about platforms still gets every library; the loop passes
// live state, so a disconnected integration strips its tools from the next turn.
interface IntegrationConnections {
  github?: boolean;
  prometheus?: boolean;
  loki?: boolean;
}

// Single source of truth for both the offered schemas and the names the loop
// resolves, so hiding a tool and gating it are one op. `platforms` undefined means
// every library, which only a caller wanting the whole catalogue passes.
export function effectiveToolset(
  platforms: Set<Platform> | undefined,
  connections: IntegrationConnections = {},
  investigation = true,
): Tool[] {
  const { github = true, prometheus = true, loki = true } = connections;
  const has = (platform: Platform): boolean =>
    platforms === undefined || platforms.has(platform);
  return [
    // Host tools ride with Docker: they gate on the platform, since host facts
    // only mean something on a runner that is 1:1 with its machine.
    ...(has("docker") ? [...DOCKER_TOOLS, ...HOST_TOOLS] : []),
    ...(has("kubernetes") ? K8S_TOOLS : []),
    ...INTERRUPT_TOOLS,
    ...(github ? [...REPO_TOOLS, ...GITHUB_TOOLS] : []),
    ...(prometheus ? PROMETHEUS_TOOLS : []),
    ...(loki ? LOKI_TOOLS : []),
    // The record is the investigation's, so a chat is offered no way to write
    // one. What a session is was decided before the run started.
    ...(investigation ? REPORT_TOOLS : []),
  ];
}

// Schemas only, for callers that just need the wire shape (e.g. tests); the loop uses
// effectiveToolset directly.
export function getToolSchemas(
  platforms?: Set<Platform>,
  connections?: IntegrationConnections,
): ToolSchema[] {
  return effectiveToolset(platforms, connections ?? {}).map((t) => t.schema);
}
