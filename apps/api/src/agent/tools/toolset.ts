import { executeRunnerTool } from "../executor.js";
import { DOCKER_TOOLS } from "./docker.js";
import { GITHUB_TOOLS } from "./github.js";
import { K8S_TOOLS } from "./kubernetes.js";
import { INTERRUPT_TOOLS } from "./interrupts.js";
import { REPO_TOOLS } from "./repo.js";
import type {
  FleetCapabilities,
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./types.js";
import type { ToolSchema } from "../../llm/types.js";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...DOCKER_TOOLS,
  ...K8S_TOOLS,
  ...INTERRUPT_TOOLS,
  ...REPO_TOOLS,
  ...GITHUB_TOOLS,
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

// Single source of truth for both the offered schemas and the names the loop resolves,
// so hiding a tool and gating it are one op. Each provider library is injected whole when
// the fleet advertises that provider; a tool cannot be offered for a substrate no runner runs.
// The GitHub integration gates two libraries the same way: repo tools (sandbox
// checkout) and the GitHub evidence tools, both meaningless without it.
export function effectiveToolset(
  caps: FleetCapabilities | undefined,
  remediationEnabled: boolean,
  githubConnected = true,
): Tool[] {
  const libraries: Tool[] = [
    ...(caps === undefined || caps.docker ? DOCKER_TOOLS : []),
    ...(caps === undefined || caps.kubernetes ? K8S_TOOLS : []),
    ...INTERRUPT_TOOLS,
    ...(githubConnected ? [...REPO_TOOLS, ...GITHUB_TOOLS] : []),
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
  githubConnected?: boolean,
): ToolSchema[] {
  return effectiveToolset(
    caps,
    remediationEnabled ?? true,
    githubConnected ?? true,
  ).map((t) => t.schema);
}
