import { executeRunnerTool } from "../executor.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../../llm/config.js";
import { DOCKER_TOOLS } from "./docker.js";
import { GITHUB_TOOLS } from "./github.js";
import { HOST_TOOLS } from "./host.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { INTERRUPT_TOOLS } from "./interrupts.js";
import { OPEN_INVESTIGATION_TOOLS } from "./investigation.js";
import { LOKI_TOOLS } from "./loki.js";
import { PROMETHEUS_TOOLS } from "./prometheus.js";
import { REPO_TOOLS } from "./repo.js";
import { REPORT_TOOLS } from "./report.js";
import type {
  Tool,
  ToolDispatchContext,
  ToolExecuteContext,
  ToolExecuteResult,
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
  ...OPEN_INVESTIGATION_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
  ...PROMETHEUS_TOOLS,
  ...LOKI_TOOLS,
  ...REPORT_TOOLS,
];

// Single dispatch chokepoint that both the live loop and the approval resume
// path pass through. The caller supplies a ceiling; a tool's own limit can only
// narrow it, never raise it past what the operator allowed.
export function executeTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<ToolExecuteResult> {
  const { toolCallCeilingMs, ...identity } = ctx;
  const effectiveCtx: ToolExecuteContext = {
    ...identity,
    toolTimeoutMs: Math.min(
      tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      toolCallCeilingMs,
    ),
  };
  if (tool.on === "api") return tool.execute(input, effectiveCtx);
  return executeRunnerTool(tool, input, effectiveCtx);
}

// The single resolver used by both the loop and human-input (resuming a stored
// interrupt); names are stable, so there is no legacy fallback.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

// Which pull-integrations are connected this turn. Each defaults to true so a
// caller that only cares about platforms still gets every library; the loop passes
// live state, so a disconnected integration strips its tools from the next turn.
export interface IntegrationConnections {
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
    // Exactly one of these is offered. The ratchet is one-way, so a session
    // already under investigation has no correct reason to be shown the tool
    // that opens one.
    ...(investigation ? REPORT_TOOLS : OPEN_INVESTIGATION_TOOLS),
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
