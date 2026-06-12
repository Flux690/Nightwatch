import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock child_process at the system boundary (external OS process execution).
// vi.mock is hoisted, so the factory must reference only vi.hoisted() values.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

import { execCommand } from "../commands/remediation.js";

describe("execCommand exit code", () => {
  beforeEach(() => {
    vi.stubEnv("REMEDIATION_ENABLED", "true");
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns exitCode 0 when the command succeeds", async () => {
    // promisify(execFile) resolves with { stdout, stderr } on success.
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, res: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout: "ok\n", stderr: "" });
      },
    );

    const result = await execCommand({
      containerName: "web-01",
      command: ["echo", "ok"],
      reason: "test",
      risk: "low",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("returns the real non-zero exit code when the command fails", async () => {
    // promisify(execFile) rejects with an error carrying the numeric exit code.
    const err = Object.assign(new Error("Process exited with code 1"), {
      code: 1,
      stdout: "",
      stderr: "command not found\n",
    });
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error) => void) => {
        cb(err);
      },
    );

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
    const err = Object.assign(new Error("exit status 2"), {
      code: 2,
      stdout: "partial output\n",
      stderr: "error detail\n",
    });
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error) => void) => {
        cb(err);
      },
    );

    const result = await execCommand({
      containerName: "app",
      command: ["grep", "pattern", "/nonexistent"],
      reason: "test",
      risk: "low",
    });

    expect(result.exitCode).toBe(2);
  });
});
