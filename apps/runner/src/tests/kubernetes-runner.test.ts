import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

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
  // setHeaderOptions is used by restartService to pass strategic-merge-patch
  // Content-Type. The mock just returns its third arg (or {}) since patchNamespacedDeployment
  // is itself mocked and never inspects the options.
  setHeaderOptions: vi.fn().mockReturnValue({}),
  // Real class (not a vi.fn) so `instanceof ApiException` works in
  // restartService/getRolloutStatus's 404-vs-genuine-error distinction.
  ApiException: class ApiException extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { ApiException } from "@kubernetes/client-node";
import {
  getContainerLogs,
  getContainerList,
  getContainerStats,
  getEnvVariableNames,
  restartService,
  execCommand as k8sExecCommand,
  getRolloutStatus,
  getNodeStatus,
} from "../kubernetes/commands.js";

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
    listNode: ReturnType<typeof vi.fn>;
  };
  let mockAppsApi: {
    readNamespacedDeployment: ReturnType<typeof vi.fn>;
    readNamespacedStatefulSet: ReturnType<typeof vi.fn>;
    patchNamespacedDeployment: ReturnType<typeof vi.fn>;
    patchNamespacedStatefulSet: ReturnType<typeof vi.fn>;
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
      listNode: vi.fn(),
    };
    mockAppsApi = {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      patchNamespacedStatefulSet: vi.fn(),
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

    it("reads the previous (dead) container's logs when resolving to a terminated pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("why it crashed\n");

      await getContainerLogs({ service: K8S_SERVICE });

      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ previous: true }),
      );
    });

    it("reads the current container's logs (not previous) for a live pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [RUNNING_POD],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("current\n");

      await getContainerLogs({ service: K8S_SERVICE });

      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ previous: false }),
      );
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

  describe("getContainerStats", () => {
    it("returns a not-running finding for a terminated pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });

      const result = await getContainerStats({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });

    it("returns metrics from the metrics-server for a live pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [RUNNING_POD],
      });
      const mockPodMetric = {
        metadata: { name: RUNNING_POD.metadata.name },
        containers: [
          { name: "api-server", usage: { cpu: "50m", memory: "128Mi" } },
        ],
      };
      MockMetrics.mockImplementation(function () {
        return {
          getPodMetrics: vi.fn().mockResolvedValue({ items: [mockPodMetric] }),
        };
      });

      const result = await getContainerStats({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        podName: RUNNING_POD.metadata.name,
        podMetric: expect.objectContaining({
          metadata: { name: RUNNING_POD.metadata.name },
        }),
      });
    });
  });

  describe("getEnvVariableNames", () => {
    it("returns env variable names from the pod spec without values", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [RUNNING_POD],
      });
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        metadata: { name: RUNNING_POD.metadata.name, namespace: "production" },
        spec: {
          containers: [
            {
              name: "api-server",
              env: [{ name: "PORT" }, { name: "NODE_ENV" }, { name: "DB_URL" }],
            },
          ],
        },
      });

      const result = await getEnvVariableNames({ service: K8S_SERVICE });

      expect(result).toEqual({ names: ["PORT", "NODE_ENV", "DB_URL"] });
    });

    it("returns a not-running finding when no pods exist", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await getEnvVariableNames({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });
  });

  describe("restartService (K8s rollout restart)", () => {
    it("patches Deployment with restartedAt annotation when a live pod exists", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      mockAppsApi.patchNamespacedDeployment.mockResolvedValue({});

      const result = await restartService({
        service: K8S_SERVICE,
        rationale: "service wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(mockAppsApi.patchNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: K8S_SERVICE.workload,
          namespace: K8S_SERVICE.namespace,
          body: expect.objectContaining({
            spec: expect.objectContaining({
              template: expect.objectContaining({
                metadata: expect.objectContaining({
                  annotations: expect.objectContaining({
                    "kubectl.kubernetes.io/restartedAt": expect.any(String),
                  }),
                }),
              }),
            }),
          }),
        }),
        expect.anything(),
      );
      expect(result).toMatchObject({
        success: true,
        resourceKind: "Deployment",
      });
    });

    it("patches StatefulSet when no Deployment exists for the workload", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      mockAppsApi.patchNamespacedDeployment.mockRejectedValue(
        new ApiException(404, "deployments.apps not found", undefined, {}),
      );
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({});

      const result = await restartService({
        service: K8S_SERVICE,
        rationale: "service wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: K8S_SERVICE.workload,
          namespace: K8S_SERVICE.namespace,
        }),
        expect.anything(),
      );
      expect(result).toMatchObject({
        success: true,
        resourceKind: "StatefulSet",
      });
    });

    it("returns not-running finding when no live pod exists", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });

      const result = await restartService({
        service: K8S_SERVICE,
        rationale: "service wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
      expect(mockAppsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("propagates a genuine StatefulSet error when neither resource patches cleanly", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      mockAppsApi.patchNamespacedDeployment.mockRejectedValue(
        new ApiException(404, "deployments.apps not found", undefined, {}),
      );
      mockAppsApi.patchNamespacedStatefulSet.mockRejectedValue(
        new Error("forbidden: patch access denied"),
      );

      await expect(
        restartService({
          service: K8S_SERVICE,
          rationale: "test",
          risk: "low",
          estimatedDowntimeSeconds: 0,
        }),
      ).rejects.toThrow("forbidden: patch access denied");
    });

    it("propagates a genuine Deployment error immediately, without masking it by trying StatefulSet", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      // The workload IS a Deployment, but the patch fails for a real reason
      // (not 404). Falling through to StatefulSet here would surface a
      // misleading "statefulsets.apps not found" instead of this error.
      mockAppsApi.patchNamespacedDeployment.mockRejectedValue(
        new Error("forbidden: patch access denied"),
      );

      await expect(
        restartService({
          service: K8S_SERVICE,
          rationale: "test",
          risk: "low",
          estimatedDowntimeSeconds: 0,
        }),
      ).rejects.toThrow("forbidden: patch access denied");
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled();
    });
  });

  describe("execCommand (K8s pod exec)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns stdout, stderr, and exitCode 0 for a successful command", async () => {
      vi.stubEnv("REMEDIATION_ENABLED", "true");
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });

      MockExec.mockImplementation(function () {
        return {
          exec: vi
            .fn()
            .mockImplementation(
              (
                _ns: string,
                _pod: string,
                _container: string,
                _cmd: string[],
                stdout: NodeJS.WritableStream,
                stderr: NodeJS.WritableStream,
                _stdin: null,
                _tty: boolean,
                statusCallback: (s: { status: string }) => void,
              ) => {
                stdout.write("hello world\n");
                stderr.write("");
                statusCallback({ status: "Success" });
                return Promise.resolve({} as WebSocket);
              },
            ),
        };
      });

      const result = await k8sExecCommand({
        service: K8S_SERVICE,
        command: ["echo", "hello world"],
        reason: "test",
        risk: "low",
      });

      expect(result).toMatchObject({ exitCode: 0, stdout: "hello world\n" });
    });

    it("returns non-zero exit code for a failed command", async () => {
      vi.stubEnv("REMEDIATION_ENABLED", "true");
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });

      MockExec.mockImplementation(function () {
        return {
          exec: vi.fn().mockImplementation(
            (
              _ns: string,
              _pod: string,
              _container: string,
              _cmd: string[],
              _stdout: NodeJS.WritableStream,
              _stderr: NodeJS.WritableStream,
              _stdin: null,
              _tty: boolean,
              statusCallback: (s: {
                status: string;
                reason?: string;
                details?: {
                  causes?: Array<{ reason?: string; message?: string }>;
                };
              }) => void,
            ) => {
              statusCallback({
                status: "Failure",
                reason: "NonZeroExitCode",
                details: { causes: [{ reason: "ExitCode", message: "2" }] },
              });
              return Promise.resolve({} as WebSocket);
            },
          ),
        };
      });

      const result = await k8sExecCommand({
        service: K8S_SERVICE,
        command: ["grep", "nonexistent", "/dev/null"],
        reason: "test",
        risk: "low",
      });

      expect(result).toMatchObject({ exitCode: 2 });
    });

    it("returns not-running finding when no live pod exists", async () => {
      vi.stubEnv("REMEDIATION_ENABLED", "true");
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });

      const result = await k8sExecCommand({
        service: K8S_SERVICE,
        command: ["ls"],
        reason: "test",
        risk: "low",
      });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });

    it("throws when REMEDIATION_ENABLED is not set to true", async () => {
      vi.stubEnv("REMEDIATION_ENABLED", "false");

      await expect(
        k8sExecCommand({
          service: K8S_SERVICE,
          command: ["ls"],
          reason: "test",
          risk: "low",
        }),
      ).rejects.toThrow("exec_command is disabled");
    });

    it("redacts secrets from K8s exec stdout before returning", async () => {
      vi.stubEnv("REMEDIATION_ENABLED", "true");
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });

      MockExec.mockImplementation(function () {
        return {
          exec: vi
            .fn()
            .mockImplementation(
              (
                _ns: string,
                _pod: string,
                _container: string,
                _cmd: string[],
                stdout: NodeJS.WritableStream,
                stderr: NodeJS.WritableStream,
                _stdin: null,
                _tty: boolean,
                statusCallback: (s: { status: string }) => void,
              ) => {
                stdout.write("token=supersecretvalue123\nstatus=ok\n");
                stderr.write("");
                statusCallback({ status: "Success" });
                return Promise.resolve({} as WebSocket);
              },
            ),
        };
      });

      const result = await k8sExecCommand({
        service: K8S_SERVICE,
        command: ["env"],
        reason: "test",
        risk: "low",
      });

      const { stdout } = result as { stdout: string };
      expect(stdout).not.toContain("supersecretvalue123");
      expect(stdout).toContain("[REDACTED]");
      expect(stdout).toContain("status=ok");
    });
  });

  describe("getRolloutStatus (K8s-only)", () => {
    it("returns Deployment rollout status when the workload is a Deployment", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload },
        spec: { replicas: 2 },
        status: {
          readyReplicas: 2,
          updatedReplicas: 2,
          availableReplicas: 2,
          conditions: [],
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        kind: "Deployment",
        replicas: 2,
        readyReplicas: 2,
      });
      expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: K8S_SERVICE.workload,
          namespace: K8S_SERVICE.namespace,
        }),
      );
    });

    it("falls back to StatefulSet when no Deployment exists", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new ApiException(404, "not found", undefined, {}),
      );
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload },
        spec: { replicas: 3 },
        status: { readyReplicas: 3, updatedReplicas: 3 },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({ kind: "StatefulSet", replicas: 3 });
    });

    it("returns not-running finding when neither Deployment nor StatefulSet exists", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new ApiException(404, "not found", undefined, {}),
      );
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(
        new ApiException(404, "not found", undefined, {}),
      );

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });

    it("propagates a genuine Deployment error immediately, without masking it by trying StatefulSet", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new Error("connection refused to kubernetes API server"),
      );

      await expect(getRolloutStatus({ service: K8S_SERVICE })).rejects.toThrow(
        "connection refused to kubernetes API server",
      );
      expect(mockAppsApi.readNamespacedStatefulSet).not.toHaveBeenCalled();
    });

    it("propagates a genuine StatefulSet error when neither resource reads cleanly", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new ApiException(404, "not found", undefined, {}),
      );
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(
        new Error("forbidden: get access denied"),
      );

      await expect(getRolloutStatus({ service: K8S_SERVICE })).rejects.toThrow(
        "forbidden: get access denied",
      );
    });
  });

  describe("getNodeStatus (K8s-only)", () => {
    it("returns per-node Ready, pressure conditions, and allocatable/capacity in native shape", async () => {
      mockCoreApi.listNode.mockResolvedValue({
        items: [
          {
            metadata: { name: "node-1" },
            status: {
              conditions: [
                { type: "MemoryPressure", status: "False" },
                { type: "DiskPressure", status: "False" },
                { type: "PIDPressure", status: "False" },
                { type: "Ready", status: "True" },
              ],
              allocatable: { cpu: "3800m", memory: "7Gi", pods: "110" },
              capacity: { cpu: "4", memory: "8Gi", pods: "110" },
            },
          },
        ],
      });

      const result = (await getNodeStatus()) as {
        nodes: Array<{
          name: string;
          conditions: Array<{ type: string; status: string }>;
          allocatable: Record<string, string>;
          capacity: Record<string, string>;
        }>;
      };

      expect(result.nodes).toHaveLength(1);
      const node = result.nodes[0]!;
      expect(node.name).toBe("node-1");
      const conditionTypes = node.conditions.map((c) => c.type);
      expect(conditionTypes).toEqual(
        expect.arrayContaining([
          "Ready",
          "MemoryPressure",
          "DiskPressure",
          "PIDPressure",
        ]),
      );
      expect(node.allocatable).toMatchObject({ cpu: "3800m" });
      expect(node.capacity).toMatchObject({ cpu: "4" });
    });
  });
});
