import { sendCommand } from "../ws/router.js";
import { logger } from "../logger.js";
import type { GetRecentCommitsInput, CommitInfo } from "@nightwatch/shared";
import type { ToolSchema } from "../llm/types.js";

export interface ToolExecuteResult {
  content: string;
  is_error?: boolean;
}

export interface ToolExecuteContext {
  runnerId?: string;
  toolTimeoutMs: number;
}

export interface Tool {
  schema: ToolSchema;
  access: "read" | "write" | "ask";
  providers: ("docker" | "kubernetes")[];
  execute(
    input: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult>;
}

const BOTH: ("docker" | "kubernetes")[] = ["docker", "kubernetes"];

async function runnerExecute(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  try {
    const result = await sendCommand(toolName, input, ctx.toolTimeoutMs, ctx.runnerId);
    return { content: JSON.stringify(result) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: toolName, err }, "runner tool failed");
    return { content: `Error executing ${toolName}: ${msg}`, is_error: true };
  }
}

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
      name: "get_container_list",
      description:
        "List all containers on the host (running and stopped) with status, image, uptime, and health.",
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
            description: "Kubernetes namespace (optional, docker ignores this).",
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_list", input, ctx),
  },
  {
    schema: {
      name: "get_container_logs",
      description:
        "Fetch recent logs for a container, pre-filtered to error/warn lines and lines near the alert timestamp.",
      input_schema: {
        type: "object",
        properties: {
          containerName: { type: "string" },
          tailLines: {
            type: "number",
            description: "Max raw lines to fetch before filtering (default 200).",
          },
          sinceTimestamp: {
            type: "string",
            description:
              "ISO 8601 timestamp. Lines within ±30s are always included.",
          },
          stderrOnly: { type: "boolean" },
        },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_logs", input, ctx),
  },
  {
    schema: {
      name: "get_container_inspect",
      description:
        "Get container configuration: image, restart policy, mounts, ports, healthcheck. Env var names only (no values).",
      input_schema: {
        type: "object",
        properties: { containerName: { type: "string" } },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_inspect", input, ctx),
  },
  {
    schema: {
      name: "get_container_stats",
      description:
        "Get real-time CPU%, memory usage/limit/%, network I/O, block I/O, and PID count for a container.",
      input_schema: {
        type: "object",
        properties: { containerName: { type: "string" } },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_stats", input, ctx),
  },
  {
    schema: {
      name: "get_container_events",
      description:
        "Get Docker events (start, stop, restart, oom, die, health_status) for a container over the last N minutes.",
      input_schema: {
        type: "object",
        properties: {
          containerName: { type: "string" },
          sinceMinutes: {
            type: "number",
            description: "Look back this many minutes (default 60).",
          },
        },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_events", input, ctx),
  },
  {
    schema: {
      name: "get_container_processes",
      description: "List processes running inside a container (like docker top).",
      input_schema: {
        type: "object",
        properties: { containerName: { type: "string" } },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_container_processes", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_host_memory", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_host_cpu", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_host_disk", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_host_network", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_host_dmesg", input, ctx),
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
          branch: { type: "string", description: "Branch name (default: main)." },
          limit: {
            type: "number",
            description: "Number of commits to return (default 10).",
          },
        },
        required: ["repoOwner", "repoName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: async (input) => {
      try {
        const commits = await fetchGitHubCommits(
          input as unknown as GetRecentCommitsInput,
        );
        return { content: JSON.stringify(commits) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `GitHub fetch failed: ${msg}`, is_error: true };
      }
    },
  },
  {
    schema: {
      name: "get_recent_deploys",
      description:
        "Get the current and previous Docker image digest for a container to detect recent deployments.",
      input_schema: {
        type: "object",
        properties: { containerName: { type: "string" } },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_recent_deploys", input, ctx),
  },
  {
    schema: {
      name: "get_env_variable_names",
      description:
        "List environment variable names (not values) for a container to check for missing config.",
      input_schema: {
        type: "object",
        properties: { containerName: { type: "string" } },
        required: ["containerName"],
      },
    },
    access: "read",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("get_env_variable_names", input, ctx),
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
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("read_file", input, ctx),
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
    providers: BOTH,
    execute: async () => ({
      content:
        "request_clarification is an interrupt and cannot be executed directly.",
      is_error: true,
    }),
  },
  {
    schema: {
      name: "restart_container",
      description:
        "WRITE: Restart a container. Requires human approval. Causes brief downtime.",
      input_schema: {
        type: "object",
        properties: {
          containerName: { type: "string" },
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
        required: [
          "containerName",
          "rationale",
          "risk",
          "estimatedDowntimeSeconds",
        ],
      },
    },
    access: "write",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("restart_container", input, ctx),
  },
  {
    schema: {
      name: "rollback_deploy",
      description:
        "WRITE: Roll back a container to its previous image digest. Requires human approval.",
      input_schema: {
        type: "object",
        properties: {
          containerName: { type: "string" },
          targetImageDigest: { type: "string" },
          rationale: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          estimatedDowntimeSeconds: { type: "number" },
        },
        required: [
          "containerName",
          "targetImageDigest",
          "rationale",
          "risk",
          "estimatedDowntimeSeconds",
        ],
      },
    },
    access: "write",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("rollback_deploy", input, ctx),
  },
  {
    schema: {
      name: "exec_command",
      description:
        "WRITE: Execute a shell command inside a container. Requires human approval and REMEDIATION_ENABLED=true.",
      input_schema: {
        type: "object",
        properties: {
          containerName: { type: "string" },
          command: {
            type: "array",
            items: { type: "string" },
            description: "Command and arguments as an array.",
          },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["containerName", "command", "reason", "risk"],
      },
    },
    access: "write",
    providers: BOTH,
    execute: (input, ctx) => runnerExecute("exec_command", input, ctx),
  },
];

export function getToolSchemas(): ToolSchema[] {
  return TOOL_REGISTRY.map((t) => t.schema);
}
