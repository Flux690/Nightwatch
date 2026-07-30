import type { Tool } from "./types.js";

// Host facts come from a Docker runner, which is 1:1 with its machine. A Kubernetes
// runner is one pod on one arbitrary node and its /proc is the pod's, so
// GetK8sNodeStatus is the Kubernetes answer to node health, not these.
const RUNNER_PROPERTY = {
  type: "string",
  description: "Runner name from the FLEET SUMMARY. Omit to read every runner.",
} as const;

export const HOST_TOOLS: Tool[] = [
  {
    schema: {
      name: "GetHostMemory",
      description:
        "Get host memory stats (total, available, swap) and whether the OOM killer has fired recently.",
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostCPU",
      description:
        "Get per-core and overall CPU usage, I/O wait %, and load averages (1m, 5m, 15m).",
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostDisk",
      description:
        "Get filesystem usage for all mounts and disk I/O rates per device.",
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
  {
    schema: {
      name: "GetHostNetwork",
      description:
        "Get listening ports, TCP connection state counts, and total connection count.",
      input_schema: {
        type: "object",
        properties: { runner: RUNNER_PROPERTY },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
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
          runner: RUNNER_PROPERTY,
        },
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
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
          runner: {
            type: "string",
            description:
              "Runner name from the FLEET SUMMARY. Required: a file read is targeted by nature.",
          },
        },
        required: ["path", "runner"],
      },
    },
    access: "read",
    on: "runner",
    routeBy: "runner",
    platform: "docker",
  },
];
