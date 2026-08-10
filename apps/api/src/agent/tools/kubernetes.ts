import { REASON_PROPERTY } from "./reason.js";
import type { Tool } from "./types.js";

// The workload's target key, copied verbatim from the FLEET SUMMARY or a list
// result - never assembled by hand. The API expands it to the structured identity.
const TARGET_PROPERTY = {
  type: "string",
  description:
    "The workload's target key, copied exactly as it appears in the FLEET SUMMARY or in a ListK8sWorkloads result, for example kubernetes/shop/api. Copy the whole string; never assemble one yourself from parts.",
} as const;

// The container sub-selector is not part of the key: it rides alongside `target`
// and selects one container in a multi-container pod.
const CONTAINER_PROPERTY = {
  type: "string",
  description:
    "Which container to read, when the workload's pod runs more than one, for example an application container alongside a sidecar. Omit it for a single-container pod. If you omit it for a pod that has several, the result lists the containers you can choose from.",
} as const;

// Consulted only when the target key is ambiguous. Supplied by the model from the fleet
// summary, stripped by the transport before dispatch, never stored, and never part of a key.
const RUNNER_PROPERTY = {
  type: "string",
  description:
    "The name of one Kubernetes cluster, written exactly as the FLEET SUMMARY lists it. Supply this only when the FLEET SUMMARY marks this target as shared, meaning two clusters advertise the same target key and it would otherwise be ambiguous which one you mean. Omit it in every other case.",
} as const;

// Read tools: run unattended, so each is a narrow typed question - never
// arbitrary shell. Safety comes from the shape, not from review.
export const K8S_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListK8sWorkloads",
      description:
        "List the Kubernetes workloads in a namespace, meaning its Deployments, StatefulSets and DaemonSets, with their replica counts, image and rollout status. Call this first when you do not yet know a workload's target key, because every service-level Kubernetes tool needs that key.",
      input_schema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description:
              "Which Kubernetes namespace to list. Defaults to the namespace named 'default', so pass this whenever the workload you want lives elsewhere.",
          },
          runner: {
            type: "string",
            description:
              "The name of one Kubernetes cluster, written exactly as the FLEET SUMMARY lists it. Omit it to read every Kubernetes cluster at once, which returns one labelled result per cluster.",
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
        "Read a Kubernetes workload's recent logs, gathered from its pods. The result is filtered down to error and warning lines plus any line close to the alert's timestamp, so a quiet workload can return very little.",
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
          since: {
            type: "string",
            description:
              "An ISO 8601 timestamp the window starts at. There is no matching end: the Kubernetes log API reads forward from a point and cannot stop at one, so these are always the newest lines after it.",
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
        "Read a Kubernetes workload's configuration: its image, update strategy, resource requests and limits, probes and volume mounts. Environment variables, ConfigMaps and Secrets are reported by name only, never by value, so this cannot tell you what a setting is set to.",
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
        "Read resource usage for every pod of a Kubernetes workload: CPU in millicores and memory in bytes, set against each container's requests and limits, along with restart counts and why each container last terminated, such as OOMKilled. If the cluster runs no metrics-server the usage figures come back null, but the restart counts and termination reasons still report, and those alone often identify the problem.",
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
        "Read the Kubernetes events for a workload and for its pods, merged into one list with the oldest first. These are events such as FailedCreate, BackOff and OOMKilling, and they are usually the fastest way to learn why a workload will not come up.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
          sinceMinutes: {
            type: "number",
            description:
              "How many minutes to look back from now. Defaults to 60.",
          },
          warningsOnly: {
            type: "boolean",
            description:
              "Whether to return only Warning events, which defaults to true. Kubernetes emits Normal events constantly, so set this to false only when you specifically need them.",
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
      description:
        "List the processes running inside a Kubernetes workload's pod. Use it to see whether the process you expect is the one actually running, and what it is consuming.",
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
        "Read the rollout status of a Deployment, StatefulSet or DaemonSet: how many replicas are desired, ready, updated and available, the workload's conditions, and the reason a rollout has not finished. Use this when you suspect a deploy is stuck part-way rather than the application being at fault.",
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
        "Read the health of every node in the cluster: whether each is Ready, its MemoryPressure, DiskPressure and PIDPressure conditions, and its allocatable resources against its capacity. Use this to tell whether an unhealthy workload is the node's fault rather than its own. It needs no target key, because it reports on every node.",
      input_schema: {
        type: "object",
        properties: {
          runner: {
            type: "string",
            description:
              "The name of one Kubernetes cluster, written exactly as the FLEET SUMMARY lists it. Omit it to read every Kubernetes cluster at once, which returns one labelled result per cluster.",
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
        "Restart a Kubernetes workload by performing a rollout restart of its Deployment, StatefulSet or DaemonSet, which replaces its pods one batch at a time. This changes the cluster, so calling it pauses you until a human approves or rejects it. If the human rejects the call, you will be told so and the restart will not have happened.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
          reason: REASON_PROPERTY,
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Your own assessment of how much damage this restart could do if it goes wrong. The human sees it labelled as your opinion, beside the facts of the call.",
          },
          estimatedDowntimeSeconds: {
            type: "number",
            description:
              "How many seconds you expect the workload to be degraded or unavailable for.",
          },
        },
        required: ["target", "reason", "risk", "estimatedDowntimeSeconds"],
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
        "Run a shell command inside a Kubernetes workload's pod, as kubectl exec does. It runs inside the pod and never on the node hosting it. Because such a command is able to change things, calling it pauses you until a human approves or rejects it, even when the command you are running only reads. Use it to answer questions the typed Kubernetes tools above do not cover, and to apply a fix once you know what the fix is.",
      input_schema: {
        type: "object",
        properties: {
          target: TARGET_PROPERTY,
          runner: RUNNER_PROPERTY,
          container: CONTAINER_PROPERTY,
          command: {
            type: "array",
            items: { type: "string" },
            description:
              "The command and its arguments, split into an array of strings, for example ['redis-cli', 'info', 'memory']. The human sees exactly this, joined by spaces, and approves that.",
          },
          reason: REASON_PROPERTY,
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Your own assessment of how much damage this command could do if it goes wrong. A command that only reads is low. The human sees it labelled as your opinion.",
          },
        },
        required: ["target", "command", "reason", "risk"],
      },
    },
    access: "write",
    on: "runner",
    routeBy: "service",
  },
];
