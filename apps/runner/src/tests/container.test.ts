import { describe, expect, it, vi } from "vitest";

const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { getContainerLogs } from "../commands/container.js";

const SERVICE = {
  provider: "docker" as const,
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
      reason: "No running instance found for myapp/postgres",
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
