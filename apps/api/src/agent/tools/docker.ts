import type { Tool } from "./types.js";

// Echo the identity exactly as given in the alert or a prior ListDockerServices
// result - do not guess. provider is a single-value enum so the wire payload
// still carries the discriminant the runner dispatches on.
const DOCKER_SERVICE_IDENTITY_SCHEMA = {
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
} as const;

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
//
// Host tools live in this library because a Docker runner is 1:1 with its
// host, so "the host" is a truthful concept. A Kubernetes runner is one pod
// on one arbitrary node; GetK8sNodeStatus is the cluster-level answer there.
export const DOCKER_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListDockerServices",
      description:
        "List all Docker services on the host (running and stopped) with status, image, uptime, and health.",
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "GetDockerLogs",
      description:
        "Fetch recent logs (the container's stdout/stderr) for a Docker service, pre-filtered to error/warn lines and lines near the alert timestamp.",
      input_schema: {
        type: "object",
        properties: {
          service: DOCKER_SERVICE_IDENTITY_SCHEMA,
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
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetDockerConfig",
      description:
        "Get a Docker service's configuration: image, restart policy, mounts, ports, healthcheck. Env var names only (no values).",
      input_schema: {
        type: "object",
        properties: { service: DOCKER_SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetDockerStats",
      description:
        "Get real-time resource usage for a Docker service: CPU %, memory used/limit/%, network I/O, and block I/O.",
      input_schema: {
        type: "object",
        properties: { service: DOCKER_SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetDockerEvents",
      description:
        "Get Docker daemon lifecycle events for a service (start, stop, oom, die).",
      input_schema: {
        type: "object",
        properties: {
          service: DOCKER_SERVICE_IDENTITY_SCHEMA,
          sinceMinutes: {
            type: "number",
            description: "Look back this many minutes (default 60).",
          },
        },
        required: ["service"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetDockerProcesses",
      description:
        "List processes running inside a Docker service (like docker top).",
      input_schema: {
        type: "object",
        properties: { service: DOCKER_SERVICE_IDENTITY_SCHEMA },
        required: ["service"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetHostMemory",
      description:
        "Get host memory stats (total, available, swap) and whether the OOM killer has fired recently.",
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "GetHostCPU",
      description:
        "Get per-core and overall CPU usage, I/O wait %, and load averages (1m, 5m, 15m).",
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "GetHostDisk",
      description:
        "Get filesystem usage for all mounts and disk I/O rates per device.",
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "GetHostNetwork",
      description:
        "Get listening ports, TCP connection state counts, and total connection count.",
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "GetHostDmesg",
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
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "ReadHostFile",
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
          server: {
            type: "string",
            description:
              "Server name exactly as shown in the FLEET SUMMARY. Required.",
          },
        },
        required: ["path", "server"],
      },
    },
    access: "read",
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "RestartDockerService",
      description:
        "WRITE: Restart a Docker service (container restart). Requires human approval. Causes brief downtime.",
      input_schema: {
        type: "object",
        properties: {
          service: DOCKER_SERVICE_IDENTITY_SCHEMA,
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
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "DockerBash",
      description:
        "WRITE: Execute a shell command inside the target Docker container (docker exec). Never runs on the host. Requires human approval. Only available when remediation is enabled.",
      input_schema: {
        type: "object",
        properties: {
          service: DOCKER_SERVICE_IDENTITY_SCHEMA,
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
    on: "runner",
    route: "service",
  },
];
