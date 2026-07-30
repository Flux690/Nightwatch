import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type Dockerode from "dockerode";

// Mock system boundaries: the Docker client, the Kubernetes client, and the
// filesystem read that recovers the host's own name.

const {
  mockListContainers,
  mockListDeployments,
  mockListStatefulSets,
  mockListDaemonSets,
  mockReadFile,
} = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockListDeployments: vi.fn(),
  mockListStatefulSets: vi.fn(),
  mockListDaemonSets: vi.fn(),
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

vi.mock("../kubernetes/client.js", () => ({
  getAppsV1Api: () => ({
    listDeploymentForAllNamespaces: mockListDeployments,
    listStatefulSetForAllNamespaces: mockListStatefulSets,
    listDaemonSetForAllNamespaces: mockListDaemonSets,
  }),
}));

import { detectCapabilities } from "../manifest/detect.js";

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

function workload(
  namespace: string,
  name: string,
  ready: Record<string, number>,
) {
  return { metadata: { namespace, name }, status: ready };
}

function noKubernetes(): void {
  mockListDeployments.mockRejectedValue(new Error("no k8s"));
  mockListStatefulSets.mockRejectedValue(new Error("no k8s"));
  mockListDaemonSets.mockRejectedValue(new Error("no k8s"));
}

function noDocker(): void {
  mockListContainers.mockRejectedValue(new Error("no docker"));
}

describe("detectCapabilities", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockReadFile.mockRejectedValue(new Error("no /proc"));
    mockListDeployments.mockResolvedValue({ items: [] });
    mockListStatefulSets.mockResolvedValue({ items: [] });
    mockListDaemonSets.mockResolvedValue({ items: [] });
    mockListContainers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("identity comes only from what the infrastructure publishes", () => {
    it("advertises a three-segment Docker key built from the Compose labels", async () => {
      mockListContainers.mockResolvedValue([
        makeContainer("c1", "myapp_api_1", "running", {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "api",
        }),
      ]);
      noKubernetes();

      const manifest = await detectCapabilities();

      expect(manifest.capabilities.services).toEqual([
        {
          identity: { provider: "docker", project: "myapp", service: "api" },
          status: "running",
        },
      ]);
    });

    it("advertises a three-segment Kubernetes key built from namespace and workload", async () => {
      noDocker();
      mockListDeployments.mockResolvedValue({
        items: [workload("production", "api-server", { readyReplicas: 2 })],
      });

      const manifest = await detectCapabilities();

      expect(manifest.capabilities.services).toEqual([
        {
          identity: {
            provider: "kubernetes",
            namespace: "production",
            workload: "api-server",
          },
          status: "running",
          kind: "Deployment",
        },
      ]);
    });
  });

  describe("Kubernetes workloads", () => {
    it("advertises all three kinds and stamps the kind the alert resolver needs", async () => {
      noDocker();
      mockListDeployments.mockResolvedValue({
        items: [workload("shop", "api", { readyReplicas: 1 })],
      });
      mockListStatefulSets.mockResolvedValue({
        items: [workload("shop", "db", { readyReplicas: 3 })],
      });
      mockListDaemonSets.mockResolvedValue({
        items: [workload("kube-system", "node-exporter", { numberReady: 4 })],
      });

      const manifest = await detectCapabilities();

      expect(
        manifest.capabilities.services.map((s) => [
          s.identity.provider === "kubernetes" ? s.identity.workload : "",
          s.kind,
        ]),
      ).toEqual([
        ["api", "Deployment"],
        ["db", "StatefulSet"],
        ["node-exporter", "DaemonSet"],
      ]);
    });

    it("reads a DaemonSet's readiness from numberReady, which counts nodes not replicas", async () => {
      noDocker();
      mockListDaemonSets.mockResolvedValue({
        items: [
          workload("kube-system", "ready-agent", { numberReady: 2 }),
          workload("kube-system", "stuck-agent", { numberReady: 0 }),
        ],
      });

      const manifest = await detectCapabilities();

      expect(manifest.capabilities.services.map((s) => s.status)).toEqual([
        "running",
        "stopped",
      ]);
    });
  });

  describe("the advertised host name", () => {
    it("reports the host's own name, not the container id os.hostname() returns", async () => {
      vi.stubEnv("HOST_PROC", "/host/proc");
      mockReadFile.mockResolvedValue("prod-web-01\n");
      noDocker();

      const manifest = await detectCapabilities();

      expect(manifest.hostname).toBe("prod-web-01");
    });

    it("falls back to the OS name when the host mount is not readable", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      noDocker();

      const manifest = await detectCapabilities();

      expect(manifest.hostname).not.toBe("");
      expect(mockReadFile).toHaveBeenCalled();
    });

    it("falls back when the file exists but is empty, rather than advertising a blank name", async () => {
      mockReadFile.mockResolvedValue("  \n");
      noDocker();

      const manifest = await detectCapabilities();

      expect(manifest.hostname.trim()).not.toBe("");
    });
  });
});
