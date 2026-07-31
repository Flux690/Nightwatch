import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotFoundResult } from "@nightwarden/shared";

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
  // setHeaderOptions is used by restartWorkload to pass strategic-merge-patch Content-Type. The mock just
  // returns its third arg (or {}) since the patch calls are themselves mocked and never inspect the options.
  setHeaderOptions: vi.fn().mockReturnValue({}),
  // Real class (not a vi.fn) so `instanceof ApiException` works in the
  // 404-vs-genuine-error distinction every multi-kind read depends on.
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
  listWorkloads,
  getWorkloadLogs,
  describeWorkload,
  getWorkloadStats,
  getWorkloadEvents,
  restartWorkload,
  execInWorkload,
  getRolloutStatus,
  getNodeStatus,
  parseCpuMillicores,
  parseMemoryBytes,
} from "../kubernetes/commands.js";

const K8S_SERVICE = {
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

// The default Deployment read: enough to yield a label selector, which is the
// gateway every pod-listing command passes through.
const DEPLOYMENT = {
  metadata: { name: "api-server", namespace: "production" },
  spec: { selector: { matchLabels: { app: "api-server" } } },
};

function notFound(): Error {
  return new ApiException(404, "not found", undefined, {});
}

// Narrows away the not-found arm so a test can read a result's own fields, and
// fails loudly (rather than on an undefined property) when the arm is wrong.
function found<T extends object>(result: T | NotFoundResult): T {
  if ("found" in result) {
    throw new Error(`expected a result, got not-found: ${result.reason}`);
  }
  return result;
}

// Drives a successful exec, writing the given streams and reporting Success.
function execReturning(stdout: string, stderr = ""): void {
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
            out: NodeJS.WritableStream,
            err: NodeJS.WritableStream,
            _stdin: null,
            _tty: boolean,
            statusCallback: (s: { status: string }) => void,
          ) => {
            out.write(stdout);
            err.write(stderr);
            statusCallback({ status: "Success" });
            return Promise.resolve({} as WebSocket);
          },
        ),
    };
  });
}

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
    readNamespacedDaemonSet: ReturnType<typeof vi.fn>;
    patchNamespacedDeployment: ReturnType<typeof vi.fn>;
    patchNamespacedStatefulSet: ReturnType<typeof vi.fn>;
    patchNamespacedDaemonSet: ReturnType<typeof vi.fn>;
    listNamespacedDeployment: ReturnType<typeof vi.fn>;
    listNamespacedStatefulSet: ReturnType<typeof vi.fn>;
    listNamespacedDaemonSet: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    MockKubeConfig.mockReset();
    MockMetrics.mockReset();
    MockExec.mockReset();

    mockCoreApi = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      readNamespacedPodLog: vi.fn(),
      listNamespacedEvent: vi.fn().mockResolvedValue({ items: [] }),
      readNamespacedPod: vi.fn(),
      listNode: vi.fn(),
    };
    mockAppsApi = {
      readNamespacedDeployment: vi.fn(),
      readNamespacedStatefulSet: vi.fn(),
      readNamespacedDaemonSet: vi.fn(),
      patchNamespacedDeployment: vi.fn(),
      patchNamespacedStatefulSet: vi.fn(),
      patchNamespacedDaemonSet: vi.fn(),
      listNamespacedDeployment: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedStatefulSet: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedDaemonSet: vi.fn().mockResolvedValue({ items: [] }),
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

    // Default: metrics-server present but reporting nothing, so a test that does
    // not care about usage still exercises the available path.
    MockMetrics.mockImplementation(function () {
      return { getPodMetrics: vi.fn().mockResolvedValue({ items: [] }) };
    });

    // Default: Deployment found with label selector app=api-server.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue(DEPLOYMENT);
  });

  describe("getWorkloadLogs", () => {
    it("fetches logs from the live pod and names where they came from", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue(
        "ERROR: connection refused\nINFO: starting up\n",
      );

      const result = await getWorkloadLogs({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        podName: RUNNING_POD.metadata.name,
        containerName: "api-server",
        podPhase: "Running",
        fromPreviousContainer: false,
        totalLines: 2,
      });
      const lines = (result as { lines: string[] }).lines;
      expect(lines.some((l) => l.includes("ERROR"))).toBe(true);
    });

    it("fails fast naming the containers when a multi-container pod is ambiguous", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            ...RUNNING_POD,
            spec: {
              containers: [{ name: "istio-proxy" }, { name: "api-server" }],
            },
          },
        ],
      });

      // No `container` given for a 2-container pod: fail fast with the choices
      // rather than silently reading the first (often the sidecar).
      const result = await getWorkloadLogs({ service: K8S_SERVICE });

      expect(result).toMatchObject({ found: false });
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain("istio-proxy");
      expect(reason).toContain("api-server");
    });

    it("targets the named container in a multi-container pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            ...RUNNING_POD,
            spec: {
              containers: [{ name: "istio-proxy" }, { name: "api-server" }],
            },
          },
        ],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("app log line\n");

      const result = await getWorkloadLogs({
        service: { ...K8S_SERVICE, container: "api-server" },
      });

      expect(result).toMatchObject({
        lines: ["app log line"],
        containerName: "api-server",
      });
      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ container: "api-server" }),
      );
    });

    it("returns a not-found finding when no pods exist for the workload", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await getWorkloadLogs({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
      expect(mockCoreApi.readNamespacedPodLog).not.toHaveBeenCalled();
    });

    it("reads the dead container of a crash loop and says so, rather than returning empty", async () => {
      // The fallback used to be silent: an empty current-container read looked
      // identical to a healthy quiet service.
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("why it crashed\n");

      const result = await getWorkloadLogs({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        fromPreviousContainer: true,
        podPhase: "Succeeded",
        lines: ["why it crashed"],
      });
      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ previous: true }),
      );
    });

    it("reads the current container (not previous) for a live pod", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("current\n");

      await getWorkloadLogs({ service: K8S_SERVICE });

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

      await getWorkloadLogs({ service: K8S_SERVICE });

      expect(mockCoreApi.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ name: "api-server-newer" }),
      );
    });

    it("propagates the raw client error when the Kubernetes API call fails", async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValue(
        new Error("connection refused to kubernetes API server"),
      );

      await expect(getWorkloadLogs({ service: K8S_SERVICE })).rejects.toThrow(
        "connection refused to kubernetes API server",
      );
    });
  });

  describe("listWorkloads", () => {
    it("lists all three kinds with identities that match the capability manifest", async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "api-server",
              namespace: "production",
              uid: "uid-dep",
              generation: 4,
            },
            spec: {
              replicas: 2,
              template: { spec: { containers: [{ image: "api:1.2.3" }] } },
            },
            status: {
              readyReplicas: 2,
              updatedReplicas: 2,
              availableReplicas: 2,
              observedGeneration: 4,
            },
          },
        ],
      });
      mockAppsApi.listNamespacedStatefulSet.mockResolvedValue({
        items: [
          {
            metadata: { name: "db", namespace: "production", uid: "uid-sts" },
            spec: {
              replicas: 3,
              template: { spec: { containers: [{ image: "pg:16" }] } },
            },
            status: { readyReplicas: 1, updatedReplicas: 3 },
          },
        ],
      });
      mockAppsApi.listNamespacedDaemonSet.mockResolvedValue({
        items: [
          {
            metadata: {
              name: "node-exporter",
              namespace: "production",
              uid: "uid-ds",
            },
            spec: { template: { spec: { containers: [{ image: "ne:1.7" }] } } },
            status: {
              desiredNumberScheduled: 4,
              numberReady: 4,
              updatedNumberScheduled: 4,
              numberAvailable: 4,
            },
          },
        ],
      });

      const { workloads } = await listWorkloads({ namespace: "production" });

      expect(workloads).toHaveLength(3);
      const api = workloads.find((w) => w.name === "api-server")!;
      // Three segments, byte-identical to what the manifest advertises.
      expect(api.target).toBe("kubernetes/production/api-server");
      expect(api).toMatchObject({
        kind: "Deployment",
        imageTag: "1.2.3",
        desiredReplicas: 2,
        readyReplicas: 2,
        status: "Healthy",
      });
      // A DaemonSet counts nodes, and those counts live under different field
      // names; they must land on the same four replica fields.
      expect(workloads.find((w) => w.name === "node-exporter")).toMatchObject({
        kind: "DaemonSet",
        desiredReplicas: 4,
        readyReplicas: 4,
        updatedReplicas: 4,
        availableReplicas: 4,
        status: "Healthy",
      });
      // Updated but not ready is Degraded, not Progressing.
      expect(workloads.find((w) => w.name === "db")?.status).toBe("Degraded");
    });

    it("reports a stale observedGeneration as Progressing, and no replicas as ScaledToZero", async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [
          {
            metadata: { name: "rolling", generation: 7 },
            spec: { replicas: 2 },
            status: {
              readyReplicas: 2,
              updatedReplicas: 2,
              observedGeneration: 6,
            },
          },
          {
            metadata: { name: "parked" },
            spec: { replicas: 0 },
            status: {},
          },
        ],
      });

      const { workloads } = await listWorkloads({});

      expect(workloads.find((w) => w.name === "rolling")?.status).toBe(
        "Progressing",
      );
      expect(workloads.find((w) => w.name === "parked")?.status).toBe(
        "ScaledToZero",
      );
    });
  });

  describe("getWorkloadStats", () => {
    const POD_WITH_LIMITS = {
      metadata: { name: "api-server-1", labels: { app: "api-server" } },
      spec: {
        nodeName: "node-1",
        containers: [
          {
            name: "api-server",
            resources: {
              requests: { cpu: "100m", memory: "128Mi" },
              limits: { cpu: "1", memory: "256Mi" },
            },
          },
        ],
      },
      status: {
        phase: "Running",
        startTime: new Date(1000).toISOString(),
        containerStatuses: [
          {
            name: "api-server",
            restartCount: 7,
            lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
          },
        ],
      },
    };

    it("reports every pod of the workload, not just one", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          POD_WITH_LIMITS,
          { ...POD_WITH_LIMITS, metadata: { name: "api-server-2" } },
        ],
      });

      const result = await getWorkloadStats({ service: K8S_SERVICE });

      expect((result as { pods: unknown[] }).pods).toHaveLength(2);
    });

    it("answers with requests, limits and restart counts when metrics-server is absent", async () => {
      // A cluster without metrics-server is a common configuration, not a
      // failure: the whole read used to error out.
      MockMetrics.mockImplementation(function () {
        return {
          getPodMetrics: vi
            .fn()
            .mockRejectedValue(new Error("the server could not find metrics")),
        };
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [POD_WITH_LIMITS],
      });

      const result = await getWorkloadStats({ service: K8S_SERVICE });

      expect(result).toMatchObject({ metricsAvailable: false });
      const container = found(result).pods[0]!.containers[0]!;
      expect(container).toMatchObject({
        cpuMillicores: null,
        memoryBytes: null,
        cpuRequestMillicores: 100,
        cpuLimitMillicores: 1000,
        memoryRequestBytes: 128 * 1024 * 1024,
        restartCount: 7,
        // The answer to a whole class of investigation.
        lastTerminationReason: "OOMKilled",
        lastTerminationExitCode: 137,
      });
    });

    it("converts metrics-server usage quantities into numbers", async () => {
      MockMetrics.mockImplementation(function () {
        return {
          getPodMetrics: vi.fn().mockResolvedValue({
            items: [
              {
                metadata: { name: "api-server-1" },
                containers: [
                  {
                    name: "api-server",
                    // metrics-server reports nanocores, not millicores.
                    usage: { cpu: "250000000n", memory: "64Mi" },
                  },
                ],
              },
            ],
          }),
        };
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [POD_WITH_LIMITS],
      });

      const result = await getWorkloadStats({ service: K8S_SERVICE });

      expect(result).toMatchObject({ metricsAvailable: true });
      expect(found(result).pods[0]!.containers[0]).toMatchObject({
        cpuMillicores: 250,
        memoryBytes: 64 * 1024 * 1024,
      });
    });

    it("returns a not-found finding when the workload matches nothing", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedDaemonSet.mockRejectedValue(notFound());

      const result = await getWorkloadStats({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });
  });

  describe("describeWorkload", () => {
    const DEPLOYMENT_SPEC = {
      metadata: {
        name: "api-server",
        namespace: "production",
        generation: 3,
        creationTimestamp: new Date(0).toISOString(),
      },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: "api-server" } },
        strategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxSurge: "25%", maxUnavailable: 0 },
        },
        template: {
          spec: {
            serviceAccountName: "api",
            containers: [
              {
                name: "api-server",
                image: "acme/api:1.2.3",
                env: [
                  { name: "PORT", value: "3000" },
                  { name: "DB_PASSWORD", value: "super-secret-value" },
                ],
                envFrom: [
                  { secretRef: { name: "api-secrets" } },
                  { configMapRef: { name: "api-config" } },
                ],
                livenessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  periodSeconds: 15,
                },
              },
            ],
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: "d" } },
            ],
          },
        },
      },
      status: { observedGeneration: 3 },
    };

    it("describes the workload, not a pod, and never leaks an env value", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue(DEPLOYMENT_SPEC);
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await describeWorkload({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        name: "api-server",
        kind: "Deployment",
        desiredReplicas: 2,
        generation: 3,
        observedGeneration: 3,
        serviceAccountName: "api",
        strategy: {
          type: "RollingUpdate",
          maxSurge: "25%",
          maxUnavailable: "0",
        },
        volumes: [{ name: "data", kind: "persistentVolumeClaim" }],
      });
      const container = found(result).containers[0]!;
      expect(container).toMatchObject({
        name: "api-server",
        envVarNames: ["PORT", "DB_PASSWORD"],
        // Names only - a Secret's contents are never read.
        envFromSources: ["api-secrets", "api-config"],
        probes: [
          expect.objectContaining({
            kind: "liveness",
            type: "http",
            periodSeconds: 15,
          }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain("super-secret-value");
    });

    it("reports a null image digest when nothing is running, since only a pod carries one", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue(DEPLOYMENT_SPEC);
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await describeWorkload({ service: K8S_SERVICE });

      expect(found(result).containers[0]).toMatchObject({ imageDigest: null });
    });

    it("takes the image digest from a running pod's containerStatuses", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue(DEPLOYMENT_SPEC);
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            ...RUNNING_POD,
            status: {
              phase: "Running",
              containerStatuses: [
                { name: "api-server", imageID: "docker://sha256:deadbeef" },
              ],
            },
          },
        ],
      });

      const result = await describeWorkload({ service: K8S_SERVICE });

      expect(found(result).containers[0]).toMatchObject({
        imageDigest: "docker://sha256:deadbeef",
      });
    });

    it("maps a StatefulSet's updateStrategy onto the one strategy field, with no surge", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        metadata: { name: "db", namespace: "production" },
        spec: {
          replicas: 3,
          selector: { matchLabels: { app: "db" } },
          updateStrategy: {
            type: "RollingUpdate",
            rollingUpdate: { maxUnavailable: 1 },
          },
          template: { spec: { containers: [] } },
        },
        status: {},
      });
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await describeWorkload({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        kind: "StatefulSet",
        // A StatefulSet replaces pods in place and never surges.
        strategy: {
          type: "RollingUpdate",
          maxSurge: null,
          maxUnavailable: "1",
        },
      });
    });

    it("returns a not-found finding when the name matches no workload of any kind", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedDaemonSet.mockRejectedValue(notFound());

      const result = await describeWorkload({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });
  });

  describe("getWorkloadEvents", () => {
    // Fixed clock, with every fixture placed relative to it: the window filter is
    // arithmetic against "now", so the fixtures have to be dated against the same one.
    const NOW = new Date("2026-07-30T12:00:00.000Z");
    const minutesAgo = (n: number): string =>
      new Date(NOW.getTime() - n * 60_000).toISOString();

    const WORKLOAD_EVENT = {
      type: "Warning",
      reason: "FailedCreate",
      message: "pods api-server- is forbidden",
      count: 3,
      lastTimestamp: minutesAgo(10),
      involvedObject: {
        kind: "Deployment",
        name: "api-server",
        namespace: "production",
      },
    };
    const POD_EVENT = {
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 9,
      lastTimestamp: minutesAgo(5),
      involvedObject: {
        kind: "Pod",
        name: "api-server-abc-xyz",
        namespace: "production",
      },
    };
    const NORMAL_EVENT = {
      type: "Normal",
      reason: "Pulled",
      message: "Container image pulled",
      count: 1,
      lastTimestamp: minutesAgo(7),
      involvedObject: {
        kind: "Pod",
        name: "api-server-abc-xyz",
        namespace: "production",
      },
    };
    const OTHER_WORKLOAD_EVENT = {
      type: "Warning",
      reason: "Unhealthy",
      message: "not ours",
      count: 1,
      lastTimestamp: minutesAgo(6),
      involvedObject: {
        kind: "Pod",
        name: "unrelated-pod",
        namespace: "production",
      },
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("merges the workload's own events with its pods', oldest first", async () => {
      mockCoreApi.listNamespacedEvent.mockResolvedValue({
        items: [POD_EVENT, WORKLOAD_EVENT, OTHER_WORKLOAD_EVENT],
      });

      const result = await getWorkloadEvents({ service: K8S_SERVICE });

      // A failing rollout reports on the controller and a failing image pull on
      // the pod; an investigation needs both, and neither belongs to a stranger.
      expect((result as { events: Array<{ reason: string }> }).events).toEqual([
        expect.objectContaining({ reason: "FailedCreate" }),
        expect.objectContaining({ reason: "BackOff" }),
      ]);
    });

    it("drops Normal events by default, since Kubernetes emits them constantly", async () => {
      mockCoreApi.listNamespacedEvent.mockResolvedValue({
        items: [NORMAL_EVENT, POD_EVENT],
      });

      const result = await getWorkloadEvents({ service: K8S_SERVICE });

      expect(result).toMatchObject({ warningsOnly: true });
      expect((result as { events: unknown[] }).events).toHaveLength(1);
    });

    it("includes Normal events when the caller asks for them", async () => {
      mockCoreApi.listNamespacedEvent.mockResolvedValue({
        items: [NORMAL_EVENT, POD_EVENT],
      });

      const result = await getWorkloadEvents({
        service: K8S_SERVICE,
        warningsOnly: false,
      });

      expect((result as { events: unknown[] }).events).toHaveLength(2);
    });

    it("excludes events older than the requested window", async () => {
      mockCoreApi.listNamespacedEvent.mockResolvedValue({
        items: [
          { ...POD_EVENT, lastTimestamp: minutesAgo(120) },
          WORKLOAD_EVENT,
        ],
      });

      const result = await getWorkloadEvents({
        service: K8S_SERVICE,
        sinceMinutes: 30,
      });

      expect((result as { events: Array<{ reason: string }> }).events).toEqual([
        expect.objectContaining({ reason: "FailedCreate" }),
      ]);
    });
  });

  describe("restartWorkload (rollout restart)", () => {
    it("patches the Deployment with a restartedAt annotation and reports the new generation", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        spec: { replicas: 1 },
      });
      mockAppsApi.patchNamespacedDeployment.mockResolvedValue({
        metadata: { generation: 9 },
      });

      const result = await restartWorkload({
        service: K8S_SERVICE,
        reason: "service wedged",
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
        kind: "Deployment",
        generation: 9,
      });
    });

    it("patches the StatefulSet when no Deployment exists for the workload", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        spec: { replicas: 1 },
      });
      mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({});

      const result = await restartWorkload({
        service: K8S_SERVICE,
        reason: "service wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, kind: "StatefulSet" });
    });

    it("patches the DaemonSet, whose replica count is how many nodes it runs on", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedDaemonSet.mockResolvedValue({
        status: { desiredNumberScheduled: 3 },
      });
      mockAppsApi.patchNamespacedDaemonSet.mockResolvedValue({
        metadata: { generation: 2 },
      });

      const result = await restartWorkload({
        service: K8S_SERVICE,
        reason: "log shipper wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(mockAppsApi.patchNamespacedDaemonSet).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        kind: "DaemonSet",
        generation: 2,
      });
    });

    it("refuses a scaled-to-zero workload, which has nothing to roll", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        spec: { replicas: 0 },
      });

      const result = await restartWorkload({
        service: K8S_SERVICE,
        reason: "service wedged",
        risk: "low",
        estimatedDowntimeSeconds: 5,
      });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
      expect(mockAppsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("propagates a genuine error from the patch", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        spec: { replicas: 1 },
      });
      mockAppsApi.patchNamespacedDeployment.mockRejectedValue(
        new Error("forbidden: patch access denied"),
      );

      await expect(
        restartWorkload({
          service: K8S_SERVICE,
          reason: "test",
          risk: "low",
          estimatedDowntimeSeconds: 0,
        }),
      ).rejects.toThrow("forbidden: patch access denied");
    });

    it("propagates a genuine error from resolving the kind, without masking it by trying the next kind", async () => {
      // A non-404 must propagate as-is, not be swallowed and retried as a
      // StatefulSet, which would surface a misleading "not found".
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new Error("forbidden: get access denied"),
      );

      await expect(
        restartWorkload({
          service: K8S_SERVICE,
          reason: "test",
          risk: "low",
          estimatedDowntimeSeconds: 0,
        }),
      ).rejects.toThrow("forbidden: get access denied");
      expect(mockAppsApi.readNamespacedStatefulSet).not.toHaveBeenCalled();
      expect(mockAppsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
    });
  });

  describe("execInWorkload (pod exec)", () => {
    it("returns stdout, exit code, and the pod it ran in", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      execReturning("hello world\n");

      const result = await execInWorkload({
        service: K8S_SERVICE,
        command: ["echo", "hello world"],
        reason: "test",
        risk: "low",
      });

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "hello world\n",
        podName: RUNNING_POD.metadata.name,
        containerName: "api-server",
      });
    });

    it("returns a non-zero exit code as a result, not a failure", async () => {
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

      const result = await execInWorkload({
        service: K8S_SERVICE,
        command: ["grep", "nonexistent", "/dev/null"],
        reason: "test",
        risk: "low",
      });

      expect(result).toMatchObject({ exitCode: 2 });
    });

    it("returns a not-found finding when no live pod exists", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [TERMINATED_POD],
      });

      const result = await execInWorkload({
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

    it("redacts secrets from exec stdout before returning", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [RUNNING_POD] });
      execReturning("token=supersecretvalue123\nstatus=ok\n");

      const result = await execInWorkload({
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

  describe("getRolloutStatus", () => {
    it("reports a complete Deployment rollout", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload, generation: 2 },
        spec: { replicas: 2 },
        status: {
          readyReplicas: 2,
          updatedReplicas: 2,
          availableReplicas: 2,
          observedGeneration: 2,
          conditions: [],
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        kind: "Deployment",
        complete: true,
        desiredReplicas: 2,
        readyReplicas: 2,
        reason: "rollout complete",
        // Only a StatefulSet tracks revisions.
        currentRevision: null,
        updateRevision: null,
      });
    });

    it("explains an incomplete rollout rather than only flagging it", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload, generation: 3 },
        spec: { replicas: 4 },
        status: {
          readyReplicas: 1,
          updatedReplicas: 2,
          availableReplicas: 1,
          observedGeneration: 3,
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        complete: false,
        reason: "2 of 4 replicas updated",
      });
    });

    it("flags a controller that has not yet observed the latest change", async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload, generation: 5 },
        spec: { replicas: 1 },
        status: {
          readyReplicas: 1,
          updatedReplicas: 1,
          availableReplicas: 1,
          observedGeneration: 4,
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        complete: false,
        reason: "the controller has not yet observed the latest change",
      });
    });

    it("carries a StatefulSet's revisions, which the other kinds do not have", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload, generation: 1 },
        spec: { replicas: 3 },
        status: {
          readyReplicas: 3,
          updatedReplicas: 3,
          availableReplicas: 3,
          observedGeneration: 1,
          currentRevision: "db-abc",
          updateRevision: "db-def",
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        kind: "StatefulSet",
        currentRevision: "db-abc",
        updateRevision: "db-def",
      });
    });

    it("reads a DaemonSet as a third kind, mapping its node counts onto the replica fields", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedDaemonSet.mockResolvedValue({
        metadata: { name: K8S_SERVICE.workload, generation: 1 },
        status: {
          desiredNumberScheduled: 5,
          numberReady: 3,
          updatedNumberScheduled: 5,
          numberAvailable: 3,
          observedGeneration: 1,
        },
      });

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toMatchObject({
        kind: "DaemonSet",
        complete: false,
        desiredReplicas: 5,
        readyReplicas: 3,
        reason: "3 of 5 replicas ready",
      });
    });

    it("returns a not-found finding when the name matches no workload of any kind", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedStatefulSet.mockRejectedValue(notFound());
      mockAppsApi.readNamespacedDaemonSet.mockRejectedValue(notFound());

      const result = await getRolloutStatus({ service: K8S_SERVICE });

      expect(result).toEqual({
        found: false,
        reason: expect.stringContaining("api-server"),
      });
    });

    it("propagates a genuine error immediately, without masking it by trying the next kind", async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(
        new Error("connection refused to kubernetes API server"),
      );

      await expect(getRolloutStatus({ service: K8S_SERVICE })).rejects.toThrow(
        "connection refused to kubernetes API server",
      );
      expect(mockAppsApi.readNamespacedStatefulSet).not.toHaveBeenCalled();
    });
  });

  describe("getNodeStatus", () => {
    it("answers whether the node, not the pod, is the cause", async () => {
      mockCoreApi.listNode.mockResolvedValue({
        items: [
          {
            metadata: { name: "node-1" },
            spec: { unschedulable: true },
            status: {
              conditions: [
                { type: "MemoryPressure", status: "False" },
                { type: "DiskPressure", status: "True", reason: "NoSpace" },
                { type: "Ready", status: "True" },
              ],
              allocatable: { cpu: "3800m", memory: "7Gi", pods: "110" },
              capacity: { cpu: "4", memory: "8Gi", pods: "110" },
              nodeInfo: { kubeletVersion: "v1.29.4" },
            },
          },
        ],
      });

      const result = await getNodeStatus();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        name: "node-1",
        ready: true,
        unschedulable: true,
        kubeletVersion: "v1.29.4",
        allocatable: { cpu: "3800m", memory: "7Gi", pods: "110" },
        capacity: { cpu: "4", memory: "8Gi", pods: "110" },
      });
      expect(result.nodes[0]?.conditions).toContainEqual(
        expect.objectContaining({ type: "DiskPressure", reason: "NoSpace" }),
      );
    });

    it("reports a node that is not Ready", async () => {
      mockCoreApi.listNode.mockResolvedValue({
        items: [
          {
            metadata: { name: "node-2" },
            status: { conditions: [{ type: "Ready", status: "False" }] },
          },
        ],
      });

      const result = await getNodeStatus();

      expect(result.nodes[0]).toMatchObject({ ready: false });
    });
  });
});

// Kubernetes quantities are strings with a unit suffix, and metrics-server reports
// CPU in nanocores, so a raw Number() would be wrong by six orders of magnitude.
describe("quantity parsing", () => {
  it("reads CPU in every unit Kubernetes emits", () => {
    expect(parseCpuMillicores("100m")).toBe(100);
    expect(parseCpuMillicores("1")).toBe(1000);
    expect(parseCpuMillicores("1.5")).toBe(1500);
    expect(parseCpuMillicores("250000000n")).toBe(250);
    expect(parseCpuMillicores("500000u")).toBe(500);
    expect(parseCpuMillicores(undefined)).toBeNull();
    expect(parseCpuMillicores("garbage")).toBeNull();
  });

  it("reads memory in both binary and decimal units", () => {
    expect(parseMemoryBytes("128Mi")).toBe(128 * 1024 * 1024);
    expect(parseMemoryBytes("1Gi")).toBe(1024 ** 3);
    expect(parseMemoryBytes("500M")).toBe(500_000_000);
    expect(parseMemoryBytes("1024")).toBe(1024);
    expect(parseMemoryBytes(undefined)).toBeNull();
    expect(parseMemoryBytes("garbage")).toBeNull();
  });
});
