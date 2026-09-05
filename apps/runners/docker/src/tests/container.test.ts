import { describe, expect, it, vi } from "vitest";

const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import type { DockerLogsResult } from "@nightwarden/shared";
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

// The engine stamps every line once timestamps are asked for.
function stamped(...lines: string[]): string {
  return lines
    .map((line, i) => `2026-08-31T02:14:0${i}.000000000Z ${line}\n`)
    .join("");
}

// Every case below is about the message; one case above pins the timestamp.
function messages(result: unknown): string[] {
  return (result as DockerLogsResult).lines.map((entry) => entry.line);
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
  function withLogs(text: string) {
    const logs = vi.fn().mockResolvedValue(muxFrame(1, text));
    MockDocker.mockImplementation(function () {
      return {
        listContainers: vi
          .fn()
          .mockResolvedValue([containerInfo("live-1", "running", 200)]),
        getContainer: vi.fn().mockReturnValue({ logs }),
      };
    });
    return logs;
  }

  // Without a time on the line there is nothing to place a log against the
  // alert, which is the whole reason a window can be aimed.
  it("asks the engine for timestamps and returns them beside the line", async () => {
    const logs = withLogs("2026-08-31T02:14:07.123456789Z error: boom\n");

    const result = await getContainerLogs({ service: SERVICE });

    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({ timestamps: true }),
    );
    expect((result as DockerLogsResult).lines).toEqual([
      { ts: "2026-08-31T02:14:07.123Z", line: "error: boom" },
    ]);
  });

  // A term matching the timestamp would keep or drop every line at once.
  it("filters on the message, never on the timestamp", async () => {
    withLogs(
      "2026-08-31T02:14:07.000000000Z error: boom\n" +
        "2026-08-31T02:14:08.000000000Z all quiet\n",
    );

    const result = await getContainerLogs({
      service: SERVICE,
      contains: ["2026"],
    });

    expect((result as DockerLogsResult).lines).toEqual([]);
    expect((result as DockerLogsResult).scannedLines).toBe(2);
  });

  it("fetches logs from the live container when one is resolved", async () => {
    const getContainer = vi.fn().mockReturnValue({
      logs: vi.fn().mockResolvedValue(muxFrame(1, stamped("error: boom"))),
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
    expect(messages(result)).toContain("error: boom");
  });

  /* tail alone only ever walks back from now, so without an end the newest lines
     are the only ones reachable. The engine takes both edges in UNIX seconds. */
  it("passes both window edges to the engine as seconds", async () => {
    const logs = vi.fn().mockResolvedValue(muxFrame(1, stamped("error: boom")));
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
          stamped(
            "connection reset by peer",
            "OOM killed pid 1234",
            "GET /health 200",
          ),
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
    })) as DockerLogsResult;

    // Matched case-insensitively, and nothing else survived.
    expect(messages(result)).toEqual(["OOM killed pid 1234"]);
    expect(result.scannedLines).toBe(3);
    expect(result.note).toContain("1 of 3");
    expect(result.note).toContain("not necessarily absent");
  });

  /* Every line, because guessing at keywords decides for the agent what counts
     as evidence: it drops "connection reset by peer" and keeps "no errors". */
  it("returns every line it read when the caller names no filter", async () => {
    const logs = vi
      .fn()
      .mockResolvedValue(
        muxFrame(1, stamped("connection reset by peer", "GET /health 200")),
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
    })) as DockerLogsResult;

    expect(messages(result)).toEqual([
      "connection reset by peer",
      "GET /health 200",
    ]);
    expect(result.note).toBe("");
  });

  // A scan that filled its tail has older lines behind it, and saying so is what
  // stops "no matches" being read as "it never happened".
  it("flags a scan that filled its tail", async () => {
    const logs = vi.fn().mockResolvedValue(muxFrame(1, stamped("a", "b", "c")));
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
    })) as DockerLogsResult;

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
              muxFrame(
                1,
                stamped("error: connecting with password=hunter2sekret"),
              ),
            ),
        }),
      };
    });

    const result = await getContainerLogs({ service: SERVICE });

    const lines = messages(result).join("\n");
    expect(lines).not.toContain("hunter2sekret");
    expect(lines).toContain("[REDACTED]");
  });

  it("falls back to the most recent stopped container and still returns logs", async () => {
    const getContainer = vi.fn().mockReturnValue({
      logs: vi
        .fn()
        .mockResolvedValue(muxFrame(1, stamped("error: crashed on exit"))),
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
    expect(messages(result)).toContain("error: crashed on exit");
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
