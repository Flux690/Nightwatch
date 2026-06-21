import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock dockerode at the system boundary (Docker Engine API).
// vi.mock is hoisted, so the factory must reference only vi.hoisted() values.
const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { execCommand } from "../commands/remediation.js";

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
    vi.stubEnv("REMEDIATION_ENABLED", "true");
    MockDocker.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns exitCode 0 when the command succeeds", async () => {
    setupDockerMock(0, "ok\n");

    const result = await execCommand({
      containerName: "web-01",
      command: ["echo", "ok"],
      reason: "test",
      risk: "low",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("returns the real non-zero exit code when the command exits non-zero", async () => {
    setupDockerMock(1, "", "command not found\n");

    const result = await execCommand({
      containerName: "web-01",
      command: ["bad-cmd"],
      reason: "test",
      risk: "low",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("command not found");
  });

  it("returns exit code 2 for commands that exit with code 2", async () => {
    setupDockerMock(2, "partial output\n", "error detail\n");

    const result = await execCommand({
      containerName: "app",
      command: ["grep", "pattern", "/nonexistent"],
      reason: "test",
      risk: "low",
    });

    expect(result.exitCode).toBe(2);
  });

  it("propagates the raw engine error when the Docker API call fails", async () => {
    const engineError = new Error(
      "permission denied while trying to connect to the Docker daemon socket",
    );
    MockDocker.mockImplementation(function () {
      return {
        getContainer: vi.fn().mockReturnValue({
          exec: vi.fn().mockRejectedValue(engineError),
        }),
      };
    });

    await expect(
      execCommand({
        containerName: "web-01",
        command: ["ls"],
        reason: "test",
        risk: "low",
      }),
    ).rejects.toThrow(
      "permission denied while trying to connect to the Docker daemon socket",
    );
  });
});
