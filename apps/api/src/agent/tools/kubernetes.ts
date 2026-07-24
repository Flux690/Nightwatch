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

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
export const K8S_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListK8sWorkloads",
      description:
        "List Kubernetes workloads (Deployments and StatefulSets) with status, image, and health.",
      input_schema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description:
              "Kubernetes namespace to list (optional; defaults to 'default').",
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
      name: "GetK8sLogs",
      description:
        "Fetch recent logs (from the workload's pods) for a Kubernetes service, pre-filtered to error/warn lines and lines near the alert timestamp.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
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
          stderrOnly: { type: "boolean" },
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sConfig",
      description:
        "Get a Kubernetes workload's configuration: image, restart policy, mounts, ports, healthcheck. Env var names only (no values).",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, container: CONTAINER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sStats",
      description:
        "Get real-time resource usage for a Kubernetes workload: CPU and memory as raw quantified values (e.g. 100m cores, 128Mi), plus network and block I/O.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, container: CONTAINER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sEvents",
      description:
        "Get Kubernetes cluster events for a workload (Pulled, BackOff, OOMKilling, etc.).",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          container: CONTAINER_PROPERTY,
          sinceMinutes: {
            type: "number",
            description: "Look back this many minutes (default 60).",
          },
        },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sProcesses",
      description: "List processes running inside a Kubernetes workload's pod.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY, container: CONTAINER_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sRolloutStatus",
      description:
        "Get the rollout status of a Deployment or StatefulSet - desired/ready/updated replica counts and conditions.",
      input_schema: {
        type: "object",
        properties: { target: TARGET_PROPERTY },
        required: ["target"],
      },
    },
    access: "read",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "GetK8sNodeStatus",
      description:
        "Get per-node health - Ready plus MemoryPressure/DiskPressure/PIDPressure conditions and allocatable-vs-capacity resources. Use to tell whether the node, not the pod, is the cause of an unhealthy workload. Reports every node; no service identity needed.",
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
      name: "RestartK8sWorkload",
      description:
        "WRITE: Restart a Kubernetes workload (rollout restart). Requires human approval. Causes a rolling replacement of pods.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          container: CONTAINER_PROPERTY,
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
        required: ["target", "rationale", "risk", "estimatedDowntimeSeconds"],
      },
    },
    access: "write",
    on: "runner",
    route: "service",
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
    route: "service",
  },
];
