import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @kubernetes/client-node at the system boundary. vi.mock is hoisted, so
// all factories reference only vi.hoisted() values.
const { MockKubeConfig, MockMetrics, MockExec } = vi.hoisted(() => ({
  MockKubeConfig: vi.fn(),
  MockMetrics: vi.fn(),
  MockExec: vi.fn(),
}));

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class CoreV1Api {},
  AppsV1Api: class AppsV1Api {},
  Metrics: MockMetrics,
  Exec: MockExec,
}));

import { getContainerLogs, getContainerList } from "../kubernetes/commands.js";

const K8S_SERVICE = {
  provider: "kubernetes" as const,
  namespace: "production",
  workload: "api-server",
};

const RUNNING_POD = {
  metadata: {
    name: "api-server-abc-xyz",
    namespace: "production",
    uid: "uid-live-1234567890ab",
    creationTimestamp: new Date(200).toISOString(),
    labels: { app: "api-server" },
  },
  status: { phase: "Running" },
  spec: { containers: [{ name: "api-server", image: "api:latest" }] },
};

const TERMINATED_POD = {
  metadata: {
    name: "api-server-old-xyz",
    namespace: "production",
    uid: "uid-old-1234567890ab",
    creationTimestamp: new Date(100).toISOString(),
    labels: { app: "api-server" },
  },
  status: { phase: "Succeeded" },
  spec: { containers: [{ name: "api-server", image: "api:latest" }] },
};

const DEPLOYMENT = {
  spec: { selector: { matchLabels: { app: "api-server" } } },
};

describe("Kubernetes runner command handlers", () => {
  let mockCoreApi: {
    listNamespacedPod: ReturnType<typeof vi.fn>;
    readNamespacedPodLog: ReturnType<typeof vi.fn>;
    listNamespacedEvent: ReturnType<typeof vi.fn>;
    readNamespacedPod: ReturnType<typeof vi.fn>;
  };
  let mockAppsApi: {
    readNamespacedDeployment: ReturnType<typeof vi.fn>;
    readNamespacedStatefulSet: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    MockKubeConfig.mockReset();
    MockMetrics.mockReset();
    MockExec.mockReset();

    mockCoreApi = {
      listNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
      listNamespacedEvent: vi.fn(),
      readNamespacedPod: vi.fn(),
    };
    mockAppsApi = {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
    };

    MockKubeConfig.mockImplementation(function () {
      return {
        loadFromDefault: vi.fn(),
        loadFromCluster: vi.fn(),
        makeApiClient: (Cls: { name: string }) => {
          if (Cls.name === "CoreV1Api") return mockCoreApi;
          if (Cls.name === "AppsV1Api") return mockAppsApi;
          throw new Error(`Unexpected API class: ${Cls.name}`);
        },
      };
    });

    // Default: Deployment found with label selector app=api-server.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue(DEPLOYMENT);
  });

  describe("getContainerLogs", () => {
    it("fetches logs from the live pod when a running instance exists", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [RUNNING_POD],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue(
        "ERROR: connection refused\nINFO: starting up\n",
      );

      const result = await getContainerLogs({ service: K8S_SERVICE });

      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({
          name: RUNNING_POD.metadata.name,
          namespace: "production",
        }),
      );
      expect(result).not.toHaveProperty("found");
      const lines = (result as { lines: string[] }).lines;
      expect(lines.some((l) => l.includes("ERROR"))).toBe(true);
    });

    it("returns a not-running finding when no pods exist for the workload", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await getContainerLogs({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
      expect(mockCoreApi.readNamespacedPodLog).not.toHaveBeenCalled();
    });

    it("falls back to the terminated pod when no live pod is available", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue(
        "last logs before exit\n",
      );

      const result = await getContainerLogs({ service: K8S_SERVICE });

      expect(result).not.toHaveProperty("found");
      const lines = (result as { lines: string[] }).lines;
      expect(lines).toContain("last logs before exit");
    });

    it("prefers the newest live pod when multiple pods exist mid-rollout", async () => {
      const olderLive = {
        ...RUNNING_POD,
        metadata: {
          ...RUNNING_POD.metadata,
          name: "api-server-older",
          creationTimestamp: new Date(100).toISOString(),
        },
      };
      const newerLive = {
        ...RUNNING_POD,
        metadata: {
          ...RUNNING_POD.metadata,
          name: "api-server-newer",
          creationTimestamp: new Date(200).toISOString(),
        },
      };
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [olderLive, newerLive],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("ok\n");

      await getContainerLogs({ service: K8S_SERVICE });

      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ name: "api-server-newer" }),
      );
    });

    it("propagates the raw client error when the Kubernetes API call fails", async () => {
      const apiError = new Error("connection refused to kubernetes API server");
      mockCoreApi.listNamespacedPod.mockRejectedValue(apiError);

      await expect(getContainerLogs({ service: K8S_SERVICE })).rejects.toThrow(
        "connection refused to kubernetes API server",
      );
    });
  });

  describe("getContainerList", () => {
    it("lists pods as container-info entries in native K8s shape", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [RUNNING_POD],
      });

      const result = await getContainerList({
        environment: "kubernetes",
        namespace: "production",
      });

      expect(result.containers).toHaveLength(1);
      const c = result.containers[0]!;
      expect(c.name).toBe(RUNNING_POD.metadata.name);
      expect(c.service).toEqual(
        expect.objectContaining({
          provider: "kubernetes",
          namespace: "production",
        }),
      );
    });
  });
});
