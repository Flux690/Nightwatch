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

  // The quiet lines worth keeping sit around whatever the caller aimed at, which
  // is the end of the window once it names one.
  it("keeps quiet lines around until rather than around since", async () => {
    const at = (iso: string, text: string): string => `${iso} ${text}`;
    const logs = vi
      .fn()
      .mockResolvedValue(
        muxFrame(
          1,
          `${at("2026-07-16T10:53:05.000Z", "near since")}\n${at("2026-07-16T11:23:05.000Z", "near until")}\n`,
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

    const result = await getContainerLogs({
      service: SERVICE,
      since: "2026-07-16T10:53:00.000Z",
      until: "2026-07-16T11:23:00.000Z",
    });

    const lines = (result as { lines: string[] }).lines;
    expect(lines.some((l) => l.includes("near until"))).toBe(true);
    expect(lines.some((l) => l.includes("near since"))).toBe(false);
  });

  /* Both lines name the same instant, so no single host offset can make a
     timezone-blind parse right about both: cutting the offset off an ISO
     timestamp reads it as local time and misses by the host's own offset. */
  it("reads a line's timestamp in the zone the line states", async () => {
    const logs = vi
      .fn()
      .mockResolvedValue(
        muxFrame(
          1,
          "2026-07-16T11:23:05.000Z utc form\n2026-07-16T16:53:05.000+05:30 offset form\n",
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

    const result = await getContainerLogs({
      service: SERVICE,
      until: "2026-07-16T11:23:00.000Z",
    });

    const lines = (result as { lines: string[] }).lines;
    expect(lines.some((l) => l.includes("utc form"))).toBe(true);
    expect(lines.some((l) => l.includes("offset form"))).toBe(true);
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
