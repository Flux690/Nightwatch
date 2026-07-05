import Dockerode from "dockerode";

export function getDocker(): Dockerode {
  return new Dockerode();
}

// Parse Docker's multiplexed stream: 8-byte header (byte 0 = type, 4-7 = BE size) +
// payload; type 2 is stderr, else stdout. TTY containers emit raw bytes, detected when
// the first byte isn't a valid mux type.
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
