import { z } from "zod";
import { declareTool } from "./schema.js";
import type { Tool } from "./types.js";

// A Docker runner is 1:1 with its machine. A Kubernetes runner is one pod on
// an arbitrary node, so GetK8sNodeStatus answers node health there.
const server = z.string().optional().meta({
  description:
    "The name of one Docker host, written exactly as the <fleet-summary> block lists it. Omit it to read every Docker host at once, which returns one labelled result per host.",
});

// Defaults are applied by the runner, so these stay optional here and say so in
// their descriptions rather than declaring a default this schema never applies.
const HOST_VITALS_INPUT = z.object({ server });

const HOST_DMESG_INPUT = z.object({
  tailLines: z.number().int().min(1).optional().meta({
    description:
      "How many of the most recent lines to return, as a whole number of 1 or more. Defaults to 100.",
  }),
  filterLevel: z.enum(["err", "warn", "all"]).optional().meta({
    description:
      "How far down the severity ladder to read. 'err', the default, returns errors alone; 'warn' returns errors and warnings; 'all' returns every level. Widen it only when the errors alone did not explain what happened.",
  }),
  server,
});

const READ_HOST_FILE_INPUT = z.object({
  path: z.string().meta({
    description: "The absolute path of the file to read.",
  }),
  maxLines: z.number().int().min(1).optional().meta({
    description:
      "How many lines to return at most, as a whole number of 1 or more. Defaults to 500.",
  }),
  server: z.string().meta({
    description:
      "The name of one Docker host, written exactly as the <fleet-summary> block lists it. This is required, because reading a file only makes sense on one named machine.",
  }),
});

// Said on every one of the six, because a description sits next to the decision
// while the system prompt is competing with a long context by turn fifteen.
const DOCKER_ONLY =
  " This reads a Docker host's own operating system and exists for Docker only; for the health of Kubernetes nodes, use GetK8sNodeStatus instead.";

export const HOST_TOOLS: Tool[] = [
  {
    ...declareTool(
      "GetHostMemory",
      "Read a Docker host's memory: total, available and swap, along with any out-of-memory kill the kernel ring buffer still holds. There is no time window on that: an OOM from days ago reports the same as one from a minute ago, so read the timestamps on the events themselves before tying one to this incident." +
        DOCKER_ONLY,
      HOST_VITALS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "GetHostCPU",
      "Read a Docker host's CPU usage per core and overall, its I/O wait percentage, and its load averages over one, five and fifteen minutes. A high I/O wait points at the disk rather than at the processor." +
        DOCKER_ONLY,
      HOST_VITALS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "GetHostDisk",
      "Read a Docker host's filesystem usage per mount, and its disk read and write rates per device. A full disk stops containers writing logs and databases accepting writes, so check it early when several services fail at once. tmpfs and udev mounts are left out, so an in-memory filesystem filling up is not visible here." +
        DOCKER_ONLY,
      HOST_VITALS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "GetHostNetwork",
      "Read a Docker host's listening ports, how many sockets are in each state, and the total socket count. Use it to tell whether a service is actually listening where you expect, or whether connections are piling up. The counts cover TCP and UDP together and include listening sockets, so the total is every socket rather than every established connection." +
        DOCKER_ONLY,
      HOST_VITALS_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "GetHostDmesg",
      "Read a Docker host's kernel log, the dmesg ring buffer, where hardware faults, out-of-memory kills and filesystem errors are recorded. This is where you confirm that the kernel, and not the application, killed a process." +
        DOCKER_ONLY,
      HOST_DMESG_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "logs",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
  {
    ...declareTool(
      "ReadHostFile",
      "Read a file from a Docker host's filesystem, such as a service's configuration. Only files under an allowlist of paths can be read, so a path outside it is refused; that refusal is a normal answer about what you may read, not a fault. Anything that looks like a secret is removed from the content before you see it." +
        DOCKER_ONLY,
      READ_HOST_FILE_INPUT,
    ),
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
    on: "runner",
    routeBy: "server",
    platform: "docker",
  },
];
