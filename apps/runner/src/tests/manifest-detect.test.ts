import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type Dockerode from "dockerode";

// Redirect /var/nightwatch to a writable temp path before identity.ts loads its
// module-level constant (DB_PATH = process.env["NIGHTWATCH_DB_PATH"] ?? ...).
// vi.hoisted runs before any import resolution so the constant picks up the env.
// No imported values are allowed here — vi.hoisted executes before imports.
vi.hoisted(() => {
  process.env["NIGHTWATCH_DB_PATH"] = "/tmp/manifest-detect-test/history.db";
});

// Mock system boundaries: Docker client, Kubernetes client, and Prometheus
// network probe (global fetch). os.hostname() is not mocked — tests assert only
// that a non-empty string is present, which is always true in any environment.

const { mockListContainers, mockListDeployments, mockListStatefulSets } =
  vi.hoisted(() => ({
    mockListContainers: vi.fn(),
    mockListDeployments: vi.fn(),
    mockListStatefulSets: vi.fn(),
  }));

vi.mock("../docker-client.js", () => ({
  getDocker: () => ({ listContainers: mockListContainers }),
}));

vi.mock("../kubernetes-client.js", () => ({
  getAppsV1Api: () => ({
    listDeploymentForAllNamespaces: mockListDeployments,
    listStatefulSetForAllNamespaces: mockListStatefulSets,
  }),
  getClusterName: vi.fn(),
}));

import { detectCapabilities } from "../manifest/detect.js";
import { getClusterName } from "../kubernetes-client.js";

const mockGetClusterName = vi.mocked(getClusterName);

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

describe("detectCapabilities — server-scoped identity stamping", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("Docker: server field", () => {
    it("stamps server from os.hostname() on each Docker identity", async () => {
      mockListContainers.mockResolvedValue([
        makeContainer("c1", "myapp_api_1", "running", {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "api",
        }),
      ]);
      mockListDeployments.mockRejectedValue(new Error("no k8s"));
      mockListStatefulSets.mockRejectedValue(new Error("no k8s"));

      const manifest = await detectCapabilities();

      const service = manifest.capabilities.services[0];
      expect(service?.identity.provider).toBe("docker");
      if (service?.identity.provider === "docker") {
        expect(typeof service.identity.server).toBe("string");
        expect(service.identity.server!.length).toBeGreaterThan(0);
      }
    });

    it("all Docker identities carry the same server value (this host)", async () => {
      mockListContainers.mockResolvedValue([
        makeContainer("c1", "myapp_api_1", "running", {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "api",
        }),
        makeContainer("c2", "myapp_db_1", "running", {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "db",
        }),
      ]);
      mockListDeployments.mockRejectedValue(new Error("no k8s"));
      mockListStatefulSets.mockRejectedValue(new Error("no k8s"));

      const manifest = await detectCapabilities();

      const servers = manifest.capabilities.services
        .filter((s) => s.identity.provider === "docker")
        .map((s) => (s.identity as { server?: string }).server);
      expect(servers.length).toBe(2);
      // All must be the same non-empty string
      expect(servers.every((s) => typeof s === "string" && s.length > 0)).toBe(
        true,
      );
      expect(new Set(servers).size).toBe(1);
    });
  });

  describe("Kubernetes: cluster field", () => {
    it("stamps cluster from NIGHTWATCH_CLUSTER_NAME env var when set", async () => {
      vi.stubEnv("NIGHTWATCH_CLUSTER_NAME", "prod-cluster");
      mockListContainers.mockRejectedValue(new Error("no docker"));
      mockListDeployments.mockResolvedValue({
        items: [
          {
            metadata: { namespace: "production", name: "api-server" },
          },
        ],
      });
      mockListStatefulSets.mockResolvedValue({ items: [] });

      const manifest = await detectCapabilities();

      const service = manifest.capabilities.services[0];
      expect(service?.identity.provider).toBe("kubernetes");
      if (service?.identity.provider === "kubernetes") {
        expect(service.identity.cluster).toBe("prod-cluster");
      }
    });

    it("stamps cluster from getClusterName() when env var is absent", async () => {
      delete process.env["NIGHTWATCH_CLUSTER_NAME"];
      mockGetClusterName.mockReturnValue("my-kubeconfig-context");
      mockListContainers.mockRejectedValue(new Error("no docker"));
      mockListDeployments.mockResolvedValue({
        items: [
          {
            metadata: { namespace: "staging", name: "worker" },
          },
        ],
      });
      mockListStatefulSets.mockResolvedValue({ items: [] });

      const manifest = await detectCapabilities();

      const service = manifest.capabilities.services[0];
      expect(service?.identity.provider).toBe("kubernetes");
      if (service?.identity.provider === "kubernetes") {
        expect(service.identity.cluster).toBe("my-kubeconfig-context");
      }
    });
  });
});
