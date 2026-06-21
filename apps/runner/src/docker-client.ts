import Dockerode from "dockerode";

export function getDocker(): Dockerode {
  return new Dockerode();
}

// Parse a Docker multiplexed log/exec stream buffer into stdout and stderr.
// Each frame: 8-byte header (byte 0 = stream type, bytes 4-7 = payload size BE)
// followed by the payload. Type 2 is stderr; all others are stdout.
export function parseDockerMux(buf: Buffer): {
  stdout: string;
  stderr: string;
} {
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
