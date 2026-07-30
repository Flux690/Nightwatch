import type { Tool } from "./types.js";

// The workload's target key, copied verbatim from the FLEET SUMMARY or a list
// result - never assembled by hand. The API expands it to the structured identity.
const TARGET_PROPERTY = {
  type: "string",
  description:
    "The workload's target key, copied exactly from the FLEET SUMMARY or a ListK8sWorkloads result (e.g. kubernetes/shop/api).",
} as const;

// The container sub-selector is not part of the key: it rides alongside `target`
// and selects one container in a multi-container pod.
const CONTAINER_PROPERTY = {
  type: "string",
  description:
    "Optional: the specific container in a multi-container pod (e.g. the app container alongside a sidecar). Required only when the pod has more than one container; omitting it then returns the list of choices.",
} as const;

// Consulted only when the target key is ambiguous. Supplied by the model from the fleet
// summary, stripped by the transport before dispatch, never stored, and never part of a key.
const RUNNER_PROPERTY = {
  type: "string",
  description:
    "Runner name from the FLEET SUMMARY. Required only when the fleet summary marks this target as shared.",
} as const;

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
export const K8S_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListK8sWorkloads",
      description:
        "List Kubernetes workloads (Deployments, StatefulSets and DaemonSets) with replica counts, image, and rollout status.",
      input_schema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description:
              "Kubernetes namespace to list (optional; defaults to 'default').",
          },
          runner: {
            type: "string",
            description:
              "Runner name from the FLEET SUMMARY. Omit to read every Kubernetes cluster.",
          },
        },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "kubernetes",
  },
  {
    schema: {
      name: "GetK8sLogs",
      description:
        "Fetch recent logs (from the workload's pods) for a Kubernetes service, pre-filtered to error/warn lines and lines near the alert timestamp.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
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
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sConfig",
      description:
        "Get a Kubernetes workload's configuration: image, update strategy, resource requests and limits, probes, and volume mounts. Env var and ConfigMap/Secret names only (never values).",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sStats",
      description:
        "Get per-pod resource usage for every pod of a Kubernetes workload: CPU millicores and memory bytes, against each container's requests and limits, plus restart counts and the last termination reason (e.g. OOMKilled). Usage is null when the cluster has no metrics-server; everything else still reports.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sEvents",
      description:
        "Get Kubernetes events for a workload AND its pods, merged oldest first (FailedCreate, BackOff, OOMKilling, etc.).",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
          sinceMinutes: {
            type: "number",
            description: "Look back this many minutes (default 60).",
          },
          warningsOnly: {
            type: "boolean",
            description:
              "Default true. Kubernetes emits Normal events constantly; set false only when you need them.",
          },
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sProcesses",
      description: "List processes running inside a Kubernetes workload's pod.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sRolloutStatus",
      description:
        "Get the rollout status of a Deployment, StatefulSet or DaemonSet - desired/ready/updated/available counts, conditions, and why it is not complete.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, runner: RUNNER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sNodeStatus",
      description:
        "Get per-node health - Ready plus MemoryPressure/DiskPressure/PIDPressure conditions and allocatable-vs-capacity resources. Use to tell whether the node, not the pod, is the cause of an unhealthy workload. Reports every node; no service identity needed.",
      input_schema: {
        type: "object",
        properties: {
          runner: {
            type: "string",
            description:
              "Runner name from the FLEET SUMMARY. Omit to read every Kubernetes cluster.",
          },
        },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "kubernetes",
  },
  {
    schema: {
      name: "RestartK8sWorkload",
      description:
        "WRITE: Restart a Kubernetes workload (rollout restart of a Deployment, StatefulSet or DaemonSet). Requires human approval. Causes a rolling replacement of pods.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
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
        required: ["target", "rationale", "risk", "estimatedDowntimeSeconds"],
      },
    },
    access: "write",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "K8sBash",
      description:
        "WRITE: Execute a shell command inside the target Kubernetes workload's pod (kubectl exec). Never runs on the host. Requires human approval. Only available when remediation is enabled.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
          command: {
            type: "array",
            items: { type: "string" },
            description: "Command and arguments as an array.",
          },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["target", "command", "reason", "risk"],
      },
    },
    access: "write",
    on: "runner",
    routeBy: "service",
  },
];
