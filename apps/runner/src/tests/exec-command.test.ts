import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock dockerode at the system boundary (Docker Engine API).
// vi.mock is hoisted, so the factory must reference only vi.hoisted() values.
const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { execCommand } from "../commands/remediation.js";

const SERVICE = {
  provider: "docker" as const,
  project: "myapp",
  service: "web-01",
};

const LIVE_CONTAINER = {
  Id: "live-1",
  Names: ["/web-01"],
  State: "running",
  Created: 100,
  Labels: {
    "com.docker.compose.project": "myapp",
    "com.docker.compose.service": "web-01",
  },
};

// Build a Docker multiplexed-stream frame (8-byte header + payload).
function muxFrame(streamType: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeExecStream(stdout: string, stderr = ""): PassThrough {
  const s = new PassThrough();
  if (stdout) s.push(muxFrame(1, stdout));
  if (stderr) s.push(muxFrame(2, stderr));
  s.push(null);
  return s;
}

function setupDockerMock(exitCode: number, stdout = "", stderr = ""): void {
  MockDocker.mockImplementation(function () {
    return {
      listContainers: vi.fn().mockResolvedValue([LIVE_CONTAINER]),
      getContainer: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          start: vi.fn().mockResolvedValue(makeExecStream(stdout, stderr)),
          inspect: vi.fn().mockResolvedValue({
            ExitCode: exitCode,
            Running: false,
            ID: "e1",
          }),
        }),
      }),
    };
  });
}

describe("execCommand handler", () => {
  beforeEach(() => {
    MockDocker.mockReset();
  });

  it("returns exitCode 0 when the command succeeds", async () => {
    setupDockerMock(0, "ok\n");

    const result = await execCommand({
      service: SERVICE,
      command: ["echo", "ok"],
      reason: "test",
      risk: "low",
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect((result as { stdout: string }).stdout).toContain("ok");
  });

  it("returns the real non-zero exit code when the command exits non-zero", async () => {
    setupDockerMock(1, "", "command not found\n");

    const result = await execCommand({
      service: SERVICE,
      command: ["bad-cmd"],
      reason: "test",
      risk: "low",
    });

    expect(result).toMatchObject({ exitCode: 1 });
    expect((result as { stderr: string }).stderr).toContain(
      "command not found",
    );
  });

  it("returns exit code 2 for commands that exit with code 2", async () => {
    setupDockerMock(2, "partial output\n", "error detail\n");

    const result = await execCommand({
      service: SERVICE,
      command: ["grep", "pattern", "/nonexistent"],
      reason: "test",
      risk: "low",
    });

    expect(result).toMatchObject({ exitCode: 2 });
  });

  it("returns a not-running finding and never calls exec when there is no live instance", async () => {
    const exec = vi.fn();
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi.fn().mockResolvedValue([]),
        getContainer: vi.fn().mockReturnValue({ exec }),
      };
    });

    const result = await execCommand({
      service: SERVICE,
      command: ["echo", "ok"],
      reason: "test",
      risk: "low",
    });

    expect(result).toEqual({
      found: false,
      reason: "No running instance found for myapp/web-01",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("redacts secrets from exec stdout before returning", async () => {
    setupDockerMock(0, "password=s3cr3t-value\nstatus=ok\n");

    const result = await execCommand({
      service: SERVICE,
      command: ["env"],
      reason: "test",
      risk: "low",
    });

    const { stdout } = result as { stdout: string };
    expect(stdout).not.toContain("s3cr3t-value");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).toContain("status=ok");
  });

  it("redacts secrets from exec stderr before returning", async () => {
    setupDockerMock(1, "", "token=mysecrettoken\nerror: connection refused\n");

    const result = await execCommand({
      service: SERVICE,
      command: ["connect"],
      reason: "test",
      risk: "low",
    });

    const { stderr } = result as { stderr: string };
    expect(stderr).not.toContain("mysecrettoken");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).toContain("connection refused");
  });

  it("caps exec stdout at 64 KB with an elision marker when output is very large", async () => {
    const bigLine = "x".repeat(1000) + "\n";
    const bigStdout = bigLine.repeat(100);
    setupDockerMock(0, bigStdout);

    const result = await execCommand({
      service: SERVICE,
      command: ["cat", "/big-file"],
      reason: "test",
      risk: "low",
    });

    const { stdout } = result as { stdout: string };
    expect(stdout).toContain("bytes elided");
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThan(bigStdout.length);
  });

  it("propagates the raw engine error when the Docker API call fails", async () => {
    const engineError = new Error(
      "permission denied while trying to connect to the Docker daemon socket",
    );
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi.fn().mockResolvedValue([LIVE_CONTAINER]),
        getContainer: vi.fn().mockReturnValue({
          exec: vi.fn().mockRejectedValue(engineError),
        }),
      };
    });

    await expect(
      execCommand({
        service: SERVICE,
        command: ["ls"],
        reason: "test",
        risk: "low",
      }),
    ).rejects.toThrow(
      "permission denied while trying to connect to the Docker daemon socket",
    );
  });
});
