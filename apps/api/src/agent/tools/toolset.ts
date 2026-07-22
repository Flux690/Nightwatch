import { executeRunnerTool } from "../executor.js";
import { DOCKER_TOOLS } from "./docker.js";
import { GITHUB_TOOLS } from "./github.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { INTERRUPT_TOOLS } from "./interrupts.js";
import { LOKI_TOOLS } from "./loki.js";
import { PROMETHEUS_TOOLS } from "./prometheus.js";
import { REPO_TOOLS } from "./repo.js";
import { REPORT_TOOLS } from "./report.js";
import type {
  FleetCapabilities,
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./types.js";
import type { ToolSchema } from "../../llm/types.js";
import type { RunMode } from "@nightwatch/shared";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...DOCKER_TOOLS,
  ...K8S_TOOLS,
  ...INTERRUPT_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
  ...PROMETHEUS_TOOLS,
  ...LOKI_TOOLS,
  ...REPORT_TOOLS,
];

// Single dispatch chokepoint that both the live loop and the approval resume path pass
// through; a per-tool timeoutMs overrides the global default here.
export function executeTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  const effectiveCtx: ToolExecuteContext =
    tool.timeoutMs === undefined
      ? ctx
      : { ...ctx, toolTimeoutMs: tool.timeoutMs };
  if (tool.on === "api") return tool.execute(input, effectiveCtx);
  return executeRunnerTool(tool.schema.name, tool.route, input, effectiveCtx);
}

// The single resolver used by both the loop and human-input (resuming a stored
// interrupt); names are stable, so there is no legacy fallback.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

// Which pull-integrations are connected this turn. Each field defaults to true
// so a caller that only cares about fleet capabilities still gets every library;
// the loop passes the live connection state so a disconnected integration strips
// its tools from the very next turn.
export interface IntegrationConnections {
  github?: boolean;
  prometheus?: boolean;
  loki?: boolean;
}

// Single source of truth for both the offered schemas and the names the loop resolves,
// so hiding a tool and gating it are one op. Each provider library is injected whole when
// the fleet advertises that provider; a tool cannot be offered for a substrate no runner runs.
// Integrations gate their own libraries the same way: GitHub gates the repo tools (sandbox
// checkout) plus the GitHub evidence tools, Prometheus gates the metrics tools, Loki the log tools.
export function effectiveToolset(
  caps: FleetCapabilities | undefined,
  remediationEnabled: boolean,
  connections: IntegrationConnections = {},
  mode: RunMode = "investigate",
): Tool[] {
  const { github = true, prometheus = true, loki = true } = connections;
  const libraries: Tool[] = [
    ...(caps === undefined || caps.docker ? DOCKER_TOOLS : []),
    ...(caps === undefined || caps.kubernetes ? K8S_TOOLS : []),
    ...INTERRUPT_TOOLS,
    ...(github ? [...REPO_TOOLS, ...GITHUB_TOOLS] : []),
    ...(prometheus ? PROMETHEUS_TOOLS : []),
    ...(loki ? LOKI_TOOLS : []),
    // The report tool exists only where the finish gate does: investigate runs.
    ...(mode === "investigate" ? REPORT_TOOLS : []),
  ];
  return remediationEnabled
    ? libraries
    : libraries.filter((t) => t.access !== "write");
}

// Schemas only, for callers that just need the wire shape (e.g. tests); the loop uses
// effectiveToolset directly.
export function getToolSchemas(
  caps?: FleetCapabilities,
  remediationEnabled?: boolean,
  connections?: IntegrationConnections,
): ToolSchema[] {
  return effectiveToolset(
    caps,
    remediationEnabled ?? true,
    connections ?? {},
  ).map((t) => t.schema);
}
