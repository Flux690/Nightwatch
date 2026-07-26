import { readFileSync } from "node:fs";
import Dockerode from "dockerode";

export function getDocker(): Dockerode {
  return new Dockerode();
}

// NightWarden's own containers, by id. Read once: a container's id cannot change
// while it runs, and this is consulted on every enumeration.
const hidden = new Set<string>();

// Our own id, read from the cgroup path the container is in. Image and Compose
// names are operator-configurable, so neither can identify us reliably.
function ownContainerId(): string | null {
  try {
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    const match = /\/docker\/containers\/([0-9a-f]{64})/.exec(mountinfo);
    if (match?.[1]) return match[1];
  } catch {
    // Not in a container, or the host does not expose it: nothing to hide.
  }
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const match = /([0-9a-f]{64})/.exec(cgroup);
    if (match?.[1]) return match[1];
  } catch {
    // Same: absence just means there is nothing of ours to exclude.
  }
  return null;
}

const self = ownContainerId();
if (self) hidden.add(self);

// The API tells the runner which container it is, over the socket it already
// uses to push remediation mode. Absent when the API runs elsewhere or on a host.
export function hideContainer(id: string): void {
  hidden.add(id);
}

// The only sanctioned way to enumerate containers. Everything the agent can see
// arrives through here - the manifest it is told about, the list tool it can call,
// and the resolver that turns a target into something addressable - so the control
// plane is absent from all three by construction rather than by three filters.
export async function listVisibleContainers(
  docker: Dockerode,
): Promise<Dockerode.ContainerInfo[]> {
  const all = await docker.listContainers({ all: true });
  return all.filter((c) => !hidden.has(c.Id));
}

// Parse Docker's multiplexed stream: 8-byte header (byte 0 = type, 4-7 = BE size) + payload; type 2
// is stderr, else stdout. TTY containers emit raw bytes, detected when the first byte isn't a valid mux type.
export function parseDockerMux(buf: Buffer): {
  stdout: string;
  stderr: string;
} {
  if (buf.length === 0) return { stdout: "", stderr: "" };

  const firstByte = buf[0];
  if (firstByte !== 1 && firstByte !== 2) {
    return { stdout: buf.toString("utf8"), stderr: "" };
  }

  let offset = 0;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) break;
    const payload = buf
      .subarray(offset + 8, offset + 8 + size)
      .toString("utf8");
    if (streamType === 2) stderrParts.push(payload);
    else stdoutParts.push(payload);
    offset += 8 + size;
  }

  return {
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
  };
}
