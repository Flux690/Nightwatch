import Dockerode from "dockerode";

export function getDocker(): Dockerode {
  return new Dockerode();
}

// Parse a Docker multiplexed log/exec stream buffer into stdout and stderr.
// Each frame: 8-byte header (byte 0 = stream type, bytes 4-7 = payload size BE)
// followed by the payload. Type 2 is stderr; all others are stdout.
// TTY containers (Config.Tty=true) output raw bytes without framing — detected
// by checking whether the first byte is a valid mux stream type (1 or 2).
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
