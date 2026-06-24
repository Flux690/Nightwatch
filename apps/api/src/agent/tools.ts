import { executeRunnerTool } from "./executor.js";
import type { GetRecentCommitsInput, CommitInfo } from "@nightwatch/shared";
import type { ToolSchema } from "../llm/types.js";

export type Provider = "docker" | "kubernetes";

export interface ToolExecuteResult {
  content: unknown;
  is_error?: boolean;
}

export interface ToolExecuteContext {
  runnerId?: string;
  toolTimeoutMs: number;
}

export interface Tool {
  schema: ToolSchema;
  access: "read" | "write" | "ask";
  // Absent means provider-agnostic: supported on every provider. An annotation
  // narrows the tool to the listed providers (ADR-0002). Only genuinely
  // provider-specific tools carry it.
  providers?: Provider[];
  execute(
    input: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult>;
}

const KUBERNETES_ONLY: Provider[] = ["kubernetes"];
const DOCKER_ONLY: Provider[] = ["docker"];

// Accepts both Docker and Kubernetes service identities. Echo the identity
// exactly as given in the alert or a prior list_services result - do not
// guess. Provider is an opaque part of the handle (ADR-0001, ADR-0002).
const SERVICE_IDENTITY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["docker"] },
        project: {
          type: "string",
          description:
            "Compose project name (or the container's own name if it has no Compose labels).",
        },
        service: {
          type: "string",
          description:
            "Compose service name (or the container's own name if it has no Compose labels).",
        },
      },
      required: ["provider", "project", "service"],
    },
    {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["kubernetes"] },
        namespace: {
          type: "string",
          description: "Kubernetes namespace the workload runs in.",
        },
        workload: {
          type: "string",
          description:
            "Deployment or StatefulSet name (the durable workload identifier, not the pod name).",
        },
      },
      required: ["provider", "namespace", "workload"],
    },
  ],
} as const;

async function fetchGitHubCommits(
  input: GetRecentCommitsInput,
): Promise<{ commits: CommitInfo[] }> {
  const { repoOwner, repoName, branch = "main", limit = 10 } = input;
  const token = process.env["GITHUB_TOKEN"];

  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/commits?sha=${branch}&per_page=${limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nightwatch-api/2",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const raw = (await res.json()) as Array<Record<string, unknown>>;
  const commits: CommitInfo[] = raw.map((c) => {
    const commit = c["commit"] as Record<string, unknown>;
    const author = commit["author"] as Record<string, unknown>;
    const sha = String(c["sha"] ?? "");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      message: String(
        (commit["message"] as string | undefined)?.split("\n")[0] ?? "",
      ),
      author: String((author?.["name"] as string | undefined) ?? ""),
      timestamp: String((author?.["date"] as string | undefined) ?? ""),
      filesChanged: [],
      additions: 0,
      deletions: 0,
    };
  });

  return { commits };
}

export const TOOL_REGISTRY: Tool[] = [
  {
    schema: {
      name: "list_services",
      description:
        "List all services on the host (running and stopped) with status, image, uptime, and health.",
      input_schema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            enum: ["docker", "kubernetes"],
            description: "Container runtime to query.",
          },
          namespace: {
            type: "string",
            description:
              "Kubernetes namespace (optional, docker ignores this).",
          },
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
        required: ["environment"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_list", input, ctx),
  },
  {
    schema: {
      name: "get_service_logs",
      description:
        "Fetch recent logs for a service, pre-filtered to error/warn lines and lines near the alert timestamp.",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          tailLines: {
            type: "number",
            description:
              "Max raw lines to fetch before filtering (default 200).",
          },
          sinceTimestamp: {
            type: "string",
            description:
              "ISO 8601 timestamp. Lines within ±30s are always included.",
          },
          stderrOnly: { type: "boolean" },
        },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_logs", input, ctx),
  },
  {
    schema: {
      name: "get_service_config",
      description:
        "Get service configuration: image, restart policy, mounts, ports, healthcheck. Env var names only (no values).",
      input_schema: {
        type: "object",
        properties: { service: SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_inspect", input, ctx),
  },
  {
    schema: {
      name: "get_service_stats",
      description:
        "Get real-time resource usage for a service: CPU, memory, network I/O, and block I/O. Docker returns percentages; Kubernetes returns raw quantified values (e.g. 100m cores, 128Mi).",
      input_schema: {
        type: "object",
        properties: { service: SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_stats", input, ctx),
  },
  {
    schema: {
      name: "get_service_events",
      description:
        "Get lifecycle events for a service. Docker returns daemon events (start, stop, oom, die). Kubernetes returns cluster events (Pulled, BackOff, OOMKilling, etc.).",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          sinceMinutes: {
            type: "number",
            description: "Look back this many minutes (default 60).",
          },
        },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_events", input, ctx),
  },
  {
    schema: {
      name: "get_service_processes",
      description: "List processes running inside a service (like docker top).",
      input_schema: {
        type: "object",
        properties: { service: SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_container_processes", input, ctx),
  },
  {
    schema: {
      name: "get_host_memory",
      description:
        "Get host memory stats (total, available, swap) and whether the OOM killer has fired recently.",
      input_schema: {
        type: "object",
        properties: {
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: DOCKER_ONLY,
    execute: (input, ctx) => executeRunnerTool("get_host_memory", input, ctx),
  },
  {
    schema: {
      name: "get_host_cpu",
      description:
        "Get per-core and overall CPU usage, I/O wait %, and load averages (1m, 5m, 15m).",
      input_schema: {
        type: "object",
        properties: {
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: DOCKER_ONLY,
    execute: (input, ctx) => executeRunnerTool("get_host_cpu", input, ctx),
  },
  {
    schema: {
      name: "get_host_disk",
      description:
        "Get filesystem usage for all mounts and disk I/O rates per device.",
      input_schema: {
        type: "object",
        properties: {
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: DOCKER_ONLY,
    execute: (input, ctx) => executeRunnerTool("get_host_disk", input, ctx),
  },
  {
    schema: {
      name: "get_host_network",
      description:
        "Get listening ports, TCP connection state counts, and total connection count.",
      input_schema: {
        type: "object",
        properties: {
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: DOCKER_ONLY,
    execute: (input, ctx) => executeRunnerTool("get_host_network", input, ctx),
  },
  {
    schema: {
      name: "get_host_dmesg",
      description:
        "Read kernel ring buffer (dmesg) for hardware errors, OOM kills, and filesystem errors.",
      input_schema: {
        type: "object",
        properties: {
          tailLines: {
            type: "number",
            description: "Number of most recent lines to return (default 100).",
          },
          filterLevel: {
            type: "string",
            enum: ["err", "warn", "all"],
            description: "Log level filter (default: err).",
          },
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: DOCKER_ONLY,
    execute: (input, ctx) => executeRunnerTool("get_host_dmesg", input, ctx),
  },
  {
    schema: {
      name: "get_recent_commits",
      description:
        "Fetch recent Git commits from GitHub to correlate code changes with the incident timeline.",
      input_schema: {
        type: "object",
        properties: {
          repoOwner: { type: "string" },
          repoName: { type: "string" },
          branch: {
            type: "string",
            description: "Branch name (default: main).",
          },
          limit: {
            type: "number",
            description: "Number of commits to return (default 10).",
          },
        },
        required: ["repoOwner", "repoName"],
      },
    },
    access: "read",
    execute: async (input) => {
      try {
        const commits = await fetchGitHubCommits(
          input as unknown as GetRecentCommitsInput,
        );
        return { content: commits };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `GitHub fetch failed: ${msg}`, is_error: true };
      }
    },
  },
  {
    schema: {
      name: "get_service_env_names",
      description:
        "List environment variable names (not values) for a service to check for missing config.",
      input_schema: {
        type: "object",
        properties: { service: SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    execute: (input, ctx) =>
      executeRunnerTool("get_env_variable_names", input, ctx),
  },
  {
    schema: {
      name: "get_k8s_rollout_status",
      description:
        "KUBERNETES ONLY: get the rollout status of a Deployment or StatefulSet - desired/ready/updated replica counts and conditions. Has no Docker equivalent; do not call with a docker service identity.",
      input_schema: {
        type: "object",
        properties: {
          service: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["kubernetes"] },
              namespace: {
                type: "string",
                description: "Kubernetes namespace the workload runs in.",
              },
              workload: {
                type: "string",
                description:
                  "Deployment or StatefulSet name (the durable workload identifier, not the pod name).",
              },
            },
            required: ["provider", "namespace", "workload"],
          },
        },
        required: ["service"],
      },
    },
    access: "read",
    providers: KUBERNETES_ONLY,
    execute: (input, ctx) =>
      executeRunnerTool("get_k8s_rollout_status", input, ctx),
  },
  {
    schema: {
      name: "get_k8s_node_status",
      description:
        "KUBERNETES ONLY: get per-node health - Ready plus MemoryPressure/DiskPressure/PIDPressure conditions and allocatable-vs-capacity resources. Use to tell whether the node, not the pod, is the cause of an unhealthy workload. Reports every node; no service identity needed.",
      input_schema: {
        type: "object",
        properties: {
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
      },
    },
    access: "read",
    providers: KUBERNETES_ONLY,
    execute: (input, ctx) =>
      executeRunnerTool("get_k8s_node_status", input, ctx),
  },
  {
    schema: {
      name: "read_file",
      description:
        "Read a file from the host filesystem (allowlisted paths only). Secrets are automatically redacted.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file." },
          maxLines: {
            type: "number",
            description: "Maximum lines to return (default 500).",
          },
          hostname: {
            type: "string",
            description:
              "Target runner hostname. Required when more than one runner is registered; omit for single-runner deployments.",
          },
        },
        required: ["path"],
      },
    },
    access: "read",
    execute: (input, ctx) => executeRunnerTool("read_file", input, ctx),
  },
  {
    schema: {
      name: "request_clarification",
      description:
        "Suspend the investigation and ask the on-call engineer a clarifying question. The UI always offers a free-text 'Other' answer alongside your options, do not add one of your own. List only the specific, named choices.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The specific question to ask.",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short option label." },
                description: {
                  type: "string",
                  description: "What this option means.",
                },
              },
              required: ["label", "description"],
            },
            description:
              "Selectable answers for the question. Do not include a catch-all option like 'Other' or 'None of the above' - the UI adds that automatically.",
          },
          multiSelect: {
            type: "boolean",
            description: "True if multiple options may be selected.",
          },
        },
        required: ["question", "options"],
      },
    },
    access: "ask",
    execute: async () => ({
      content:
        "request_clarification is an interrupt and cannot be executed directly.",
      is_error: true,
    }),
  },
  {
    schema: {
      name: "restart_service",
      description:
        "WRITE: Restart a service. Requires human approval. Causes brief downtime.",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          delaySeconds: {
            type: "number",
            description: "Delay before restart (default 0).",
          },
          rationale: {
            type: "string",
            description: "Why this restart is the correct remediation.",
          },
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          estimatedDowntimeSeconds: { type: "number" },
        },
        required: ["service", "rationale", "risk", "estimatedDowntimeSeconds"],
      },
    },
    access: "write",
    execute: (input, ctx) => executeRunnerTool("restart_container", input, ctx),
  },
  {
    schema: {
      name: "exec_command",
      description:
        "WRITE: Execute a shell command inside a container. Requires human approval and REMEDIATION_ENABLED=true.",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          command: {
            type: "array",
            items: { type: "string" },
            description: "Command and arguments as an array.",
          },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["service", "command", "reason", "risk"],
      },
    },
    access: "write",
    execute: (input, ctx) => executeRunnerTool("exec_command", input, ctx),
  },
];

// A tool with no `providers` annotation is provider-agnostic and runs on every
// provider; an annotation narrows it to the listed providers (ADR-0002). Single
// home for the "absent means all" rule, shared by schema filtering and the
// loop's provider-mismatch rejection so they can never diverge.
export function toolSupportsProvider(tool: Tool, provider: string): boolean {
  // provider is a plain string so the loop can pass an arbitrary model-supplied
  // value; widening the annotation to string[] is always safe and lets an
  // unrecognized provider read as unsupported (the mismatch we want to report).
  return (
    tool.providers === undefined ||
    (tool.providers as readonly string[]).includes(provider)
  );
}

// Maps pre-rename LLM-facing tool names to their current schema.name. Used by
// the resolver to execute interrupt records written before the rename deployed.
// The breaker window (10 min) ensures no old-named records remain in
// remediation_actions by the time this mapping could be removed.
const LEGACY_TOOL_NAMES: Record<string, string> = {
  get_container_list: "list_services",
  get_container_logs: "get_service_logs",
  get_container_inspect: "get_service_config",
  get_container_stats: "get_service_stats",
  get_container_events: "get_service_events",
  get_container_processes: "get_service_processes",
  get_env_variable_names: "get_service_env_names",
  restart_container: "restart_service",
};

// Look up a tool by its current schema.name, falling back to the legacy name
// map for interrupt records written before the tool rename deployed.
export function findTool(toolName: string): Tool | undefined {
  const direct = TOOL_REGISTRY.find((t) => t.schema.name === toolName);
  if (direct) return direct;
  const newName = LEGACY_TOOL_NAMES[toolName];
  if (newName) return TOOL_REGISTRY.find((t) => t.schema.name === newName);
  return undefined;
}

// Provider-specific tools are offered only to fleets that include a matching
// provider; agnostic tools pass for any fleet. Omitting the filter shows every
// tool, regardless of fleet. remediationEnabled === false strips every
// access: "write" tool from the offered set (REMEDIATION_ENABLED master
// switch, ADR-0003); omitting it, or passing true, offers every tool as
// before, so existing callers are unaffected.
export function getToolSchemas(
  fleetProviders?: ReadonlySet<Provider>,
  remediationEnabled?: boolean,
): ToolSchema[] {
  const eligible =
    remediationEnabled === false
      ? TOOL_REGISTRY.filter((t) => t.access !== "write")
      : TOOL_REGISTRY;
  if (!fleetProviders) return eligible.map((t) => t.schema);
  return eligible
    .filter((t) => [...fleetProviders].some((p) => toolSupportsProvider(t, p)))
    .map((t) => t.schema);
}
