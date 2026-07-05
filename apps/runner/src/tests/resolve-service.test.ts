import { describe, expect, it, vi } from "vitest";
import type Dockerode from "dockerode";
import { resolveService } from "../docker/resolve-service.js";

function containerInfo(
  overrides: Partial<Dockerode.ContainerInfo> & { Id: string },
): Dockerode.ContainerInfo {
  return {
    Id: overrides.Id,
    Names: overrides.Names ?? ["/some-name"],
    Image: "image:latest",
    ImageID: "sha256:abc",
    Command: "",
    Created: overrides.Created ?? 0,
    Ports: [],
    Labels: overrides.Labels ?? {},
    State: overrides.State ?? "running",
    Status: overrides.Status ?? "Up",
    HostConfig: { NetworkMode: "default" },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  } as Dockerode.ContainerInfo;
}

function makeDocker(containers: Dockerode.ContainerInfo[]): Dockerode {
  return {
    listContainers: vi.fn().mockResolvedValue(containers),
    getContainer: vi.fn().mockImplementation((id: string) => ({ id })),
  } as unknown as Dockerode;
}

const IDENTITY = {
  provider: "docker" as const,
  project: "myapp",
  service: "postgres",
};

describe("resolveService", () => {
  it("matches a running container by Compose project/service labels", async () => {
    const docker = makeDocker([
      containerInfo({
        Id: "live-1",
        Names: ["/myapp_postgres_1"],
        State: "running",
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({
      id: "live-1",
      name: "myapp_postgres_1",
      live: true,
    });
  });

  it("prefers the live container over a stopped one with the same identity (redeploy)", async () => {
    const docker = makeDocker([
      containerInfo({
        Id: "old-stopped",
        Names: ["/myapp_postgres_1"],
        State: "exited",
        Created: 100,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
      containerInfo({
        Id: "new-live",
        Names: ["/myapp_postgres_2"],
        State: "running",
        Created: 200,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "new-live", live: true });
  });

  it("picks the most recently created instance when two are briefly live together mid-redeploy", async () => {
    const docker = makeDocker([
      // The older one is listed FIRST: a naive "first running container wins"
      // implementation would pick this one, which is the wrong answer.
      containerInfo({
        Id: "older-live",
        Names: ["/myapp_postgres_1"],
        State: "running",
        Created: 100,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
      containerInfo({
        Id: "newer-live",
        Names: ["/myapp_postgres_2"],
        State: "running",
        Created: 200,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "newer-live", live: true });
  });

  it("falls back to the most recently created stopped container when nothing is live", async () => {
    const docker = makeDocker([
      containerInfo({
        Id: "older-stopped",
        Names: ["/myapp_postgres_1"],
        State: "exited",
        Created: 100,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
      containerInfo({
        Id: "newer-stopped",
        Names: ["/myapp_postgres_2"],
        State: "exited",
        Created: 200,
        Labels: {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
      }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toMatchObject({ id: "newer-stopped", live: false });
  });

  it("falls back to a literal name match for anonymous containers with no Compose labels", async () => {
    const docker = makeDocker([
      containerInfo({
        Id: "anon-1",
        Names: ["/redis-cache"],
        State: "running",
        Labels: {},
      }),
    ]);

    const resolved = await resolveService(docker, {
      provider: "docker",
      project: "redis-cache",
      service: "redis-cache",
    });

    expect(resolved).toMatchObject({ id: "anon-1", live: true });
  });

  it("returns null when no container matches the identity at all", async () => {
    const docker = makeDocker([
      containerInfo({ Id: "unrelated", Names: ["/nginx"], Labels: {} }),
    ]);

    const resolved = await resolveService(docker, IDENTITY);

    expect(resolved).toBeNull();
  });

  it("rejects a non-docker identity with a corrective message instead of treating it as missing", async () => {
    const docker = makeDocker([]);

    await expect(
      resolveService(docker, {
        provider: "kubernetes",
        namespace: "default",
        workload: "postgres",
      }),
    ).rejects.toThrow(/only supports Docker/);
  });

  it("propagates a genuine Docker daemon failure instead of treating it as a missing service", async () => {
    const docker = {
      listContainers: vi
        .fn()
        .mockRejectedValue(new Error("connect ENOENT /var/run/docker.sock")),
      getContainer: vi.fn(),
    } as unknown as Dockerode;

    await expect(resolveService(docker, IDENTITY)).rejects.toThrow(
      "connect ENOENT /var/run/docker.sock",
    );
  });
});
