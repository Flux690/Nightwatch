import { readFileSync } from "node:fs";
import Dockerode from "dockerode";

export function getDocker(): Dockerode {
  return new Dockerode();
}

// NightWarden's own containers, by id. Read once: a container's id cannot change
// while it runs, and this is consulted on every enumeration.
const hidden = new Set<string>();

// This process's own container id, or null when it is not containerized. The
// mountinfo pattern is anchored on the containers path because that file also
// lists overlay layer directories, whose names are 64-hex and are not ids.
function ownContainerId(): string | null {
  const sources: Array<[string, RegExp]> = [
    ["/proc/self/mountinfo", /\/docker\/containers\/([0-9a-f]{64})/],
    ["/proc/self/cgroup", /\b([0-9a-f]{64})\b/],
  ];
  for (const [file, pattern] of sources) {
    try {
      const match = pattern.exec(readFileSync(file, "utf8"));
      if (match?.[1]) return match[1];
    } catch {
      // Not containerized, or the host does not expose it: nothing to identify.
    }
  }
  return null;
}

// Identity by container id: image and Compose names are operator-configurable,
// so neither can identify us reliably.
const self = ownContainerId();
if (self) hidden.add(self);

// The API tells the runner which container it is, over the command socket.
// Absent when the API runs elsewhere or on a host.
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
