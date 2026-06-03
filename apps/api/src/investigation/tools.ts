import Anthropic from "@anthropic-ai/sdk";

// Runner tools that require human approval before execution.
// This is a property of certain runner tools, not a separate routing destination.
export const REQUIRES_APPROVAL = new Set([
  "restart_container",
  "rollback_deploy",
  "exec_command",
]);

// Tools handled entirely on the platform (API) side — never reach the runner.
export const PLATFORM_TOOLS = new Set([
  "request_clarification",
  "get_recent_commits",
]);

// Every tool that routes to the runner via sendCommand.
// REQUIRES_APPROVAL is a subset: those tools go through the approval gate first.
export const RUNNER_TOOLS = new Set([
  "get_container_list",
  "get_container_logs",
  "get_container_inspect",
  "get_container_stats",
  "get_container_events",
  "get_container_processes",
  "get_host_memory",
  "get_host_cpu",
  "get_host_disk",
  "get_host_network",
  "get_host_dmesg",
  "get_incident_history",
  "get_recent_deploys",
  "get_env_variable_names",
  "read_file",
  "restart_container",
  "rollback_deploy",
  "exec_command",
]);

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
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
      },
      required: ["environment"],
    },
  },
  {
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
  {
    name: "get_container_inspect",
    description:
      "Get container configuration: image, restart policy, mounts, ports, healthcheck. Env var names only (no values).",
    input_schema: {
      type: "object",
      properties: { containerName: { type: "string" } },
      required: ["containerName"],
    },
  },
  {
    name: "get_container_stats",
    description:
      "Get real-time CPU%, memory usage/limit/%, network I/O, block I/O, and PID count for a container.",
    input_schema: {
      type: "object",
      properties: { containerName: { type: "string" } },
      required: ["containerName"],
    },
  },
  {
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
  {
    name: "get_container_processes",
    description: "List processes running inside a container (like docker top).",
    input_schema: {
      type: "object",
      properties: { containerName: { type: "string" } },
      required: ["containerName"],
    },
  },
  {
    name: "get_host_memory",
    description:
      "Get host memory stats (total, available, swap) and whether the OOM killer has fired recently.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_host_cpu",
    description:
      "Get per-core and overall CPU usage, I/O wait %, and load averages (1m, 5m, 15m).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_host_disk",
    description:
      "Get filesystem usage for all mounts and disk I/O rates per device.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_host_network",
    description:
      "Get listening ports, TCP connection state counts, and total connection count.",
    input_schema: { type: "object", properties: {} },
  },
  {
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
      },
    },
  },
  {
    name: "get_incident_history",
    description:
      "Look up past incidents from the runner SQLite database to identify recurrence patterns.",
    input_schema: {
      type: "object",
      properties: {
        containerName: {
          type: "string",
          description: "Filter by container name (omit for all containers).",
        },
        limitDays: {
          type: "number",
          description: "Look back this many days (default 30).",
        },
      },
    },
  },
  {
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
  {
    name: "get_recent_deploys",
    description:
      "Get the current and previous Docker image digest for a container to detect recent deployments.",
    input_schema: {
      type: "object",
      properties: { containerName: { type: "string" } },
      required: ["containerName"],
    },
  },
  {
    name: "get_env_variable_names",
    description:
      "List environment variable names (not values) for a container to check for missing config.",
    input_schema: {
      type: "object",
      properties: { containerName: { type: "string" } },
      required: ["containerName"],
    },
  },
  {
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
      },
      required: ["path"],
    },
  },
  {
    name: "request_clarification",
    description:
      "Ask the on-call engineer a clarifying question when critical context is missing before concluding.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Specific question to ask.",
        },
        context: {
          type: "string",
          description: "What you already know that prompted this question.",
        },
      },
      required: ["question", "context"],
    },
  },
  {
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
  {
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
  {
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
];
