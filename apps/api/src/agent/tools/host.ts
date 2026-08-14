import type { Tool } from "./types.js";

// Host facts come from a Docker runner, which is 1:1 with its machine. A Kubernetes
// runner is one pod on one arbitrary node and its /proc is the pod's, so
// GetK8sNodeStatus is the Kubernetes answer to node health, not these.
const RUNNER_PROPERTY = {
  type: "string",
  description:
    "The name of one Docker host, written exactly as the FLEET SUMMARY lists it. Omit it to read every Docker host at once, which returns one labelled result per host.",
} as const;

// Said on every one of the six, because a description sits next to the decision
// while the system prompt is competing with a long context by turn fifteen.
const DOCKER_ONLY =
  " This reads a Docker host's own operating system and exists for Docker only; for the health of Kubernetes nodes, use GetK8sNodeStatus instead.";

export const HOST_TOOLS: Tool[] = [
  {
    schema: {
      name: "GetHostMemory",
      description:
        "Read a Docker host's memory: total, available and swap, along with whether the kernel's out-of-memory killer has fired recently. Use this when a container died without explanation, since the host running out of memory is a common cause." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostCPU",
      description:
        "Read a Docker host's CPU usage per core and overall, its I/O wait percentage, and its load averages over one, five and fifteen minutes. A high I/O wait points at the disk rather than at the processor." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostDisk",
      description:
        "Read a Docker host's filesystem usage for every mount, and its disk read and write rates per device. A full disk stops containers writing logs and databases accepting writes, so check it early when several services fail at once." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostNetwork",
      description:
        "Read a Docker host's listening ports, how many TCP connections are in each state, and the total connection count. Use it to tell whether a service is actually listening where you expect, or whether connections are piling up." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostDmesg",
      description:
        "Read a Docker host's kernel log, the dmesg ring buffer, where hardware faults, out-of-memory kills and filesystem errors are recorded. This is where you confirm that the kernel, and not the application, killed a process." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: {
          tailLines: {
            type: "number",
            description:
              "How many of the most recent lines to return. Defaults to 100.",
          },
          filterLevel: {
            type: "string",
            enum: ["err", "warn", "all"],
            description:
              "Which severity to include. Defaults to 'err'. Use 'all' only when the errors alone did not explain what happened.",
          },
          runner: RUNNER_PROPERTY,
        },
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "logs",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "ReadHostFile",
      description:
        "Read a file from a Docker host's filesystem, such as a service's configuration. Only files under an allowlist of paths can be read, so a path outside it is refused; that refusal is a normal answer about what you may read, not a fault. Anything that looks like a secret is removed from the content before you see it." +
        DOCKER_ONLY,
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute path of the file to read.",
          },
          maxLines: {
            type: "number",
            description: "How many lines to return at most. Defaults to 500.",
          },
          runner: {
            type: "string",
            description:
              "The name of one Docker host, written exactly as the FLEET SUMMARY lists it. This is required, because reading a file only makes sense on one named machine.",
          },
        },
        required: ["path", "runner"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
];
