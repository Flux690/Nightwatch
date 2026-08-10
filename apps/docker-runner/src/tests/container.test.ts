import { describe, expect, it, vi } from "vitest";

const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { getContainerLogs } from "../docker/commands.js";

const SERVICE = {
  project: "myapp",
  service: "postgres",
};

function muxFrame(streamType: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function containerInfo(id: string, state: string, created: number) {
  return {
    Id: id,
    Names: [`/${id}`],
    State: state,
    Created: created,
    Labels: {
      "com.docker.compose.project": "myapp",
      "com.docker.compose.service": "postgres",
    },
  };
}

describe("getContainerLogs", () => {
  it("fetches logs from the live container when one is resolved", async () => {
    const getContainer = vi.fn().mockReturnValue({
      logs: vi.fn().mockResolvedValue(muxFrame(1, "error: boom\n")),
    });
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([
            containerInfo("stopped-old", "exited", 100),
            containerInfo("live-1", "running", 200),
          ]),
        getContainer,
      };
    });

    const result = await getContainerLogs({ service: SERVICE });

    expect(getContainer).toHaveBeenCalledWith("live-1");
    expect("found" in result).toBe(false);
    expect((result as { lines: string[] }).lines).toContain("error: boom");
  });

  /* tail alone only ever walks back from now, so without an end the newest lines
     are the only ones reachable. The engine takes both edges in UNIX seconds. */
  it("passes both window edges to the engine as seconds", async () => {
    const logs = vi.fn().mockResolvedValue(muxFrame(1, "error: boom\n"));
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({ logs }),
      };
    });

    await getContainerLogs({
      service: SERVICE,
      since: "2026-07-16T10:53:00.000Z",
      until: "2026-07-16T11:23:00.000Z",
    });

    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({
        since: Date.parse("2026-07-16T10:53:00.000Z") / 1000,
        until: Date.parse("2026-07-16T11:23:00.000Z") / 1000,
      }),
    );
  });

  /* The engine applies the tail before any filtering, so a filtered count is a
     fact about the lines searched and never about the log. */
  it("filters on the caller's words and says what it searched", async () => {
    const logs = vi
      .fn()
      .mockResolvedValue(
        muxFrame(
          1,
          "connection reset by peer\nOOM killed pid 1234\nGET /health 200\n",
        ),
      );
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({ logs }),
      };
    });

    const result = (await getContainerLogs({
      service: SERVICE,
      contains: ["oom"],
    })) as { lines: string[]; scannedLines: number; note: string };

    // Matched case-insensitively, and nothing else survived.
    expect(result.lines).toEqual(["OOM killed pid 1234"]);
    expect(result.scannedLines).toBe(3);
    expect(result.note).toContain("1 of 3");
    expect(result.note).toContain("not necessarily absent");
  });

  /* The keyword guess this replaced dropped "connection reset by peer" and kept
     "no errors found", deciding for the agent what counted as evidence. */
  it("returns every line it read when the caller names no filter", async () => {
    const logs = vi
      .fn()
      .mockResolvedValue(
        muxFrame(1, "connection reset by peer\nGET /health 200\n"),
      );
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({ logs }),
      };
    });

    const result = (await getContainerLogs({ service: SERVICE })) as {
      lines: string[];
      note: string;
    };

    expect(result.lines).toEqual([
      "connection reset by peer",
      "GET /health 200",
    ]);
    expect(result.note).toBe("");
  });

  // A scan that filled its tail has older lines behind it, and saying so is what
  // stops "no matches" being read as "it never happened".
  it("flags a scan that filled its tail", async () => {
    const logs = vi.fn().mockResolvedValue(muxFrame(1, "a\nb\nc\n"));
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({ logs }),
      };
    });

    const result = (await getContainerLogs({
      service: SERVICE,
      tailLines: 3,
      contains: ["nothing matches this"],
    })) as { lines: string[]; scanHitTail: boolean; note: string };

    expect(result.lines).toEqual([]);
    expect(result.scanHitTail).toBe(true);
    expect(result.note).toContain("older lines were not searched");
  });

  // Logs are the likeliest place a secret rides out, so they are redacted where the
  // raw bytes enter rather than trusting each caller to remember.
  it("redacts a secret in a log line before it can leave the host", async () => {
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({
          logs: vi
            .fn()
            .mockResolvedValue(
              muxFrame(1, "error: connecting with password=hunter2sekret\n"),
            ),
        }),
      };
    });

    const result = await getContainerLogs({ service: SERVICE });

    const lines = (result as { lines: string[] }).lines.join("\n");
    expect(lines).not.toContain("hunter2sekret");
    expect(lines).toContain("[REDACTED]");
  });

  it("falls back to the most recent stopped container and still returns logs", async () => {
    const getContainer = vi.fn().mockReturnValue({
      logs: vi.fn().mockResolvedValue(muxFrame(1, "error: crashed on exit\n")),
    });
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([
            containerInfo("older-stopped", "exited", 100),
            containerInfo("newer-stopped", "exited", 200),
          ]),
        getContainer,
      };
    });

    const result = await getContainerLogs({ service: SERVICE });

    expect(getContainer).toHaveBeenCalledWith("newer-stopped");
    expect("found" in result).toBe(false);
    expect((result as { lines: string[] }).lines).toContain(
      "error: crashed on exit",
    );
  });

  it("returns a not-running finding (not an error) when nothing matches", async () => {
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi.fn().mockResolvedValue([]),
        getContainer: vi.fn(),
      };
    });

    const result = await getContainerLogs({ service: SERVICE });

    expect(result).toEqual({
      found: false,
      reason: "No running container found for myapp/postgres",
    });
  });

  it("propagates a genuine engine error when the live container is found but the logs call itself fails", async () => {
    const engineError = new Error("permission denied reading container logs");
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({
          logs: vi.fn().mockRejectedValue(engineError),
        }),
      };
    });

    await expect(getContainerLogs({ service: SERVICE })).rejects.toThrow(
      "permission denied reading container logs",
    );
  });
});
