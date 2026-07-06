import { SERVICE_IDENTITY_SCHEMA } from "./identity-schema.js";
import type { Provider, Tool } from "./types.js";

const KUBERNETES_ONLY: Provider[] = ["kubernetes"];
// Host tools are truthful only where runner and host are 1:1 (Docker). A K8s
// runner is one pod on one arbitrary node, so /proc there describes a random
// node; get_k8s_node_status is the cluster-level answer instead.
const DOCKER_ONLY: Provider[] = ["docker"];

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
export const OBSERVABILITY_TOOLS: Tool[] = [
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
    // Discovery call with no service identity: hostname targets the runner,
    // `environment` picks the provider handler on it.
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "host",
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
    on: "runner",
    route: "service",
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
    on: "runner",
    route: "host",
  },
  {
    schema: {
      name: "read_host_file",
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
    on: "runner",
    route: "host",
  },
];
