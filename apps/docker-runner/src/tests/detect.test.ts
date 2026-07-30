import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";

// Mock system boundaries: the Docker client and the filesystem read that
// recovers the host's own name.
const { mockListContainers, mockReadFile } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mockReadFile }));

vi.mock("../docker/client.js", () => ({
  getDocker: () => ({ listContainers: mockListContainers }),
  // Stands in for the real enumerator, which lists then drops our own containers.
  listVisibleContainers: (docker: {
    listContainers: typeof mockListContainers;
  }) => docker.listContainers({ all: true }),
}));

import { buildDockerManifest } from "../manifest/detect.js";

function makeContainer(
  id: string,
  name: string,
  state: string,
  labels: Record<string, string>,
): Dockerode.ContainerInfo {
  return {
    Id: id,
    Names: [`/${name}`],
    Image: "img",
    ImageID: "sha256:abc",
    Command: "",
    Created: 0,
    Ports: [],
    Labels: labels,
    State: state,
    Status: "Up",
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  } as Dockerode.ContainerInfo;
}

describe("buildDockerManifest", () => {
  beforeEach(() => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockListContainers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("declares its platform rather than reporting what it found", async () => {
    const manifest = await buildDockerManifest();
    expect(manifest.platform).toBe("docker");
  });

  it("advertises a three-segment key built from the Compose labels, and carries it", async () => {
    mockListContainers.mockResolvedValue([
      makeContainer("c1", "myapp_api_1", "running", {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "api",
      }),
    ]);

    const manifest = await buildDockerManifest();

    expect(manifest.services).toEqual([
      {
        identity: { project: "myapp", service: "api" },
        target: "docker/myapp/api",
        status: "running",
      },
    ]);
  });

  // An unreachable daemon is a failure to report, not a reason to advertise nothing
  // and go looking for something else to be.
  it("propagates an unreachable Docker daemon instead of reporting an empty fleet", async () => {
    mockListContainers.mockRejectedValue(new Error("no docker"));
    await expect(buildDockerManifest()).rejects.toThrow(/no docker/);
  });

  describe("the advertised host name", () => {
    it("reports the host's own name, not the container id os.hostname() returns", async () => {
      vi.stubEnv("HOST_PROC", "/host/proc");
      mockReadFile.mockResolvedValue("prod-web-01\n");

      const manifest = await buildDockerManifest();

      expect(manifest.hostname).toBe("prod-web-01");
    });

    it("falls back to the OS name when the host mount is not readable", async () => {
      const manifest = await buildDockerManifest();

      expect(manifest.hostname).not.toBe("");
      expect(mockReadFile).toHaveBeenCalled();
    });

    it("falls back when the file exists but is empty, rather than advertising a blank name", async () => {
      mockReadFile.mockResolvedValue("  \n");

      const manifest = await buildDockerManifest();

      expect(manifest.hostname.trim()).not.toBe("");
    });
  });
});
