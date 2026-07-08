import { executeRunnerTool } from "../executor.js";
import { OBSERVABILITY_TOOLS } from "./observability.js";
import { INTERRUPT_TOOLS } from "./interrupts.js";
import { REMEDIATION_TOOLS } from "./remediation.js";
import { REPO_TOOLS, REPO_TOOL_NAMES } from "./repo.js";
import type {
  Provider,
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./types.js";
import type { ToolSchema } from "../../llm/types.js";

// A runner tool's schema.name IS the wire command, addressed by its declared
// route; an api tool's execute IS its implementation - no mapping table.
export const TOOL_REGISTRY: Tool[] = [
  ...OBSERVABILITY_TOOLS,
  ...INTERRUPT_TOOLS,
  ...REMEDIATION_TOOLS,
  ...REPO_TOOLS,
];

// No `providers` annotation means provider-agnostic (runs everywhere); an annotation
// narrows it. Single home for the "absent means all" rule, shared by schema
// filtering and the mismatch check.
export function toolSupportsProvider(tool: Tool, provider: string): boolean {
  // provider is a plain string so the loop can pass an arbitrary model-supplied
  // value; widening the annotation to string[] is always safe and lets an
  // unrecognized provider read as unsupported (the mismatch we want to report).
  return (
    tool.providers === undefined ||
    (tool.providers as readonly string[]).includes(provider)
  );
}

// Single dispatch: api tools run their own handler in this process; runner
// tools ship schema.name (the wire command) with their declared route. A
// per-tool timeoutMs overrides the global default here, the one chokepoint
// both the live loop and the approval resume path pass through.
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

// Resolve a tool by its schema.name. The single resolver used by both the loop
// (live tool calls) and human-input (resuming a stored interrupt); names are
// stable, so there is no legacy fallback.
export function findTool(toolName: string): Tool | undefined {
  return TOOL_REGISTRY.find((t) => t.schema.name === toolName);
}

// The effective tool set: the single source of truth for both the offered schemas and the
// names the loop resolves. remediationEnabled false removes write tools, the
// fleet filter drops tools no runner serves, repoToolsAvailable false drops
// the repo tools - so hiding a tool and gating it are one op.
export function effectiveToolset(
  fleetProviders: ReadonlySet<Provider> | undefined,
  remediationEnabled: boolean,
  repoToolsAvailable = true,
): Tool[] {
  let eligible = remediationEnabled
    ? TOOL_REGISTRY
    : TOOL_REGISTRY.filter((t) => t.access !== "write");
  if (!repoToolsAvailable) {
    eligible = eligible.filter((t) => !REPO_TOOL_NAMES.has(t.schema.name));
  }
  if (!fleetProviders) return eligible;
  return eligible.filter((t) =>
    [...fleetProviders].some((p) => toolSupportsProvider(t, p)),
  );
}

// Schemas only, for callers that just need the wire shape (e.g. tests); the loop uses
// effectiveToolset directly. undefined remediationEnabled means no master-switch filter
// (offer every tool).
export function getToolSchemas(
  fleetProviders?: ReadonlySet<Provider>,
  remediationEnabled?: boolean,
  repoToolsAvailable?: boolean,
): ToolSchema[] {
  return effectiveToolset(
    fleetProviders,
    remediationEnabled ?? true,
    repoToolsAvailable ?? true,
  ).map((t) => t.schema);
}
