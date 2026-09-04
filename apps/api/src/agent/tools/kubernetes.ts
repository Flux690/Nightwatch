import { ARGS_PROPERTY, EXECUTABLE_PROPERTY } from "./exec.js";
import { REASON_PROPERTY } from "./reason.js";
import type { Tool } from "./types.js";

// The workload's target key, copied verbatim from the <fleet-summary> block or a list
// result - never assembled by hand. The API expands it to the structured identity.
const TARGET_PROPERTY = {
  type: "string",
  description:
    "The workload's target key, copied exactly as it appears in the <fleet-summary> block or in a ListK8sWorkloads result, for example prod-cluster/shop/api. Copy the whole string; never assemble one yourself from parts.",
} as const;

// The container sub-selector is not part of the key: it rides alongside `target`
// and selects one container in a multi-container pod.
const CONTAINER_PROPERTY = {
  type: "string",
  description:
    "Which container to read, when the workload's pod runs more than one, for example an application container alongside a sidecar. Omit it for a single-container pod. If you omit it for a pod that has several, the result lists the containers you can choose from.",
} as const;

// Read tools: run unattended, so each is a narrow typed question - never an
// arbitrary command. Safety comes from the shape, not from review.
export const K8S_TOOLS: Tool[] = [
  {
    schema: {
      name: "ListK8sWorkloads",
      description:
        "List the Kubernetes workloads in a namespace, meaning its Deployments, StatefulSets and DaemonSets, with their replica counts, image and rollout status. Call this first when you do not yet know a workload's target key, because every service-level Kubernetes tool needs that key.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          namespace: {
            type: "string",
            description:
              "Which Kubernetes namespace to list. Defaults to the namespace named 'default', so pass this whenever the workload you want lives elsewhere.",
          },
          server: {
            type: "string",
            description:
              "The name of one Kubernetes cluster, written exactly as the <fleet-summary> block lists it. Omit it to read every Kubernetes cluster at once, which returns one labelled result per cluster.",
          },
        },
        required: [],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
    on: "runner",
    routeBy: "server",
    platform: "kubernetes",
  },
  {
    schema: {
      name: "GetK8sLogs",
      description:
        "Read a Kubernetes workload's recent logs, gathered from its pods. Every line comes back with the timestamp the apiserver recorded against it, so you can line a log up with when the alert fired. Nothing is filtered unless you ask: the newest lines are read, then your own contains and excludes are applied to them.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: TARGET_PROPERTY,
          container: CONTAINER_PROPERTY,
          tailLines: {
            type: "number",
            description:
              "How many of the newest lines to search, applied by the apiserver before contains and excludes. Defaults to 200. This is the size of the search, not the size of the answer, and says nothing about the lines it never read. Raise it to look further back.",
          },
          contains: {
            type: "array",
            items: { type: "string" },
            description:
              "Keep only lines holding any one of these words, matched as plain text and ignoring case. Omit it to read the lines as they are.",
          },
          excludes: {
            type: "array",
            items: { type: "string" },
            description:
              "Drop lines holding any one of these words, matched as plain text and ignoring case. Applied before contains, so an excluded line never returns.",
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
    effect: "read",
    policy: "auto",
    evidenceKind: "logs",
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
        additionalProperties: false,
        properties: { target: TARGET_PROPERTY },
        required: ["target"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
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
        additionalProperties: false,
        properties: { target: TARGET_PROPERTY },
        required: ["target"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "GetK8sEvents",
      description:
        "Read the Kubernetes events for a workload and for its pods, merged into one list with the oldest first. These are events such as FailedCreate, BackOff and OOMKilling, and they are usually the fastest way to learn why a workload will not come up. Kubernetes deletes events on a timer, commonly one hour, so an empty list can mean the evidence expired rather than that nothing happened. Read the note on the result before concluding anything from an empty one.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: TARGET_PROPERTY,
          sinceMinutes: {
            type: "number",
            description:
              "How many minutes to look back from now. Defaults to 60. Asking for more than that is worth doing when the result says older events exist, but a longer window cannot recover events Kubernetes has already deleted.",
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
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
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
        additionalProperties: false,
        properties: {
          target: TARGET_PROPERTY,
          container: CONTAINER_PROPERTY,
        },
        required: ["target"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
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
        additionalProperties: false,
        properties: { target: TARGET_PROPERTY },
        required: ["target"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
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
        additionalProperties: false,
        properties: {
          server: {
            type: "string",
            description:
              "The name of one Kubernetes cluster, written exactly as the <fleet-summary> block lists it. Omit it to read every Kubernetes cluster at once, which returns one labelled result per cluster.",
          },
        },
        required: [],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "state",
    on: "runner",
    routeBy: "server",
    platform: "kubernetes",
  },
  {
    schema: {
      name: "RestartK8sWorkload",
      description:
        "Restart a Kubernetes workload by performing a rollout restart of its Deployment, StatefulSet or DaemonSet, which replaces its pods one batch at a time.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: TARGET_PROPERTY,
          reason: REASON_PROPERTY,
          estimatedDowntimeSeconds: {
            type: "number",
            description:
              "How many seconds you expect the workload to be degraded or unavailable for.",
          },
        },
        required: ["target", "reason", "estimatedDowntimeSeconds"],
      },
    },
    effect: "write",
    policy: "approve",
    evidenceKind: "text",
    on: "runner",
    routeBy: "service",
  },
  {
    schema: {
      name: "K8sExec",
      description:
        "Run one program inside a Kubernetes workload's pod, as kubectl exec does. The program runs inside the pod and never on the node hosting it, and the result carries its exit code, its standard output and its standard error. NightWarden starts no shell, so every argument reaches the program exactly as you write it and characters such as |, > and ; are ordinary text; to use shell syntax, name a shell as the executable and pass the whole script as one argument. The effect of an arbitrary command cannot be known in advance, so every call is treated as a write until a person decides otherwise. Use it to answer a question the typed Kubernetes tools above do not cover, and to apply a fix once you know what the fix is.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: TARGET_PROPERTY,
          container: CONTAINER_PROPERTY,
          executable: EXECUTABLE_PROPERTY,
          args: ARGS_PROPERTY,
          reason: REASON_PROPERTY,
        },
        required: ["target", "executable", "reason"],
      },
    },
    effect: "write",
    policy: "approve",
    evidenceKind: "text",
    on: "runner",
    routeBy: "service",
  },
];
