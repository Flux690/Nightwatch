import { describe, expect, it, vi } from "vitest";

// promisify(execFile) is what host.ts calls, so the custom impl is the spy.
const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = function () {} as unknown as Record<symbol, unknown>;
  execFile[promisify.custom] = execFileAsync;
  return { execFile };
});

import { getHostDmesg } from "../commands/host.js";

function levelsPassedTo(call: unknown[]): string[] {
  return (call[1] as string[]).filter((arg) => arg !== "-T");
}

describe("getHostDmesg", () => {
  // A ladder, so narrowing to errors is a question the agent can actually ask:
  // err and warn selected the same two levels and neither meant what it said.
  it("selects a severity rather than treating every level alike", async () => {
    execFileAsync.mockResolvedValue({ stdout: "[Mon] Out of memory\n" });

    await getHostDmesg({ filterLevel: "err" });
    expect(levelsPassedTo(execFileAsync.mock.calls[0]!)).toEqual([
      "--level",
      "err",
    ]);

    await getHostDmesg({ filterLevel: "warn" });
    expect(levelsPassedTo(execFileAsync.mock.calls[1]!)).toEqual([
      "--level",
      "err,warn",
    ]);

    await getHostDmesg({ filterLevel: "all" });
    expect(levelsPassedTo(execFileAsync.mock.calls[2]!)).toEqual([]);
  });
});
