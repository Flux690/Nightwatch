import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the one system boundary this builder touches: the Kubernetes apps API.
const { mockListDeployments, mockListStatefulSets, mockListDaemonSets } =
  vi.hoisted(() => ({
    mockListDeployments: vi.fn(),
    mockListStatefulSets: vi.fn(),
    mockListDaemonSets: vi.fn(),
  }));

vi.mock("../kubernetes/client.js", () => ({
  getAppsV1Api: () => ({
    listDeploymentForAllNamespaces: mockListDeployments,
    listStatefulSetForAllNamespaces: mockListStatefulSets,
    listDaemonSetForAllNamespaces: mockListDaemonSets,
  }),
}));

import { buildKubernetesManifest } from "../manifest/detect.js";

function workload(
  namespace: string,
  name: string,
  ready: Record<string, number>,
) {
  return { metadata: { namespace, name }, status: ready };
}

describe("buildKubernetesManifest", () => {
  beforeEach(() => {
    mockListDeployments.mockResolvedValue({ items: [] });
    mockListStatefulSets.mockResolvedValue({ items: [] });
    mockListDaemonSets.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("declares its platform rather than reporting what it found", async () => {
    const manifest = await buildKubernetesManifest();
    expect(manifest.platform).toBe("kubernetes");
  });

  it("advertises a three-segment key built from namespace and workload, and carries it", async () => {
    mockListDeployments.mockResolvedValue({
      items: [workload("production", "api-server", { readyReplicas: 2 })],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services).toEqual([
      {
        identity: { namespace: "production", workload: "api-server" },
        target: "kubernetes/production/api-server",
        status: "running",
        kind: "Deployment",
      },
    ]);
  });

  it("advertises all three kinds and stamps the kind the alert resolver needs", async () => {
    mockListDeployments.mockResolvedValue({
      items: [workload("shop", "api", { readyReplicas: 1 })],
    });
    mockListStatefulSets.mockResolvedValue({
      items: [workload("shop", "db", { readyReplicas: 3 })],
    });
    mockListDaemonSets.mockResolvedValue({
      items: [workload("kube-system", "node-exporter", { numberReady: 4 })],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services.map((s) => [s.identity.workload, s.kind])).toEqual(
      [
        ["api", "Deployment"],
        ["db", "StatefulSet"],
        ["node-exporter", "DaemonSet"],
      ],
    );
  });

  it("reads a DaemonSet's readiness from numberReady, which counts nodes not replicas", async () => {
    mockListDaemonSets.mockResolvedValue({
      items: [
        workload("kube-system", "ready-agent", { numberReady: 2 }),
        workload("kube-system", "stuck-agent", { numberReady: 0 }),
      ],
    });

    const manifest = await buildKubernetesManifest();

    expect(manifest.services.map((s) => s.status)).toEqual([
      "running",
      "stopped",
    ]);
  });

  // An unreachable API server is a failure to report, not a reason to advertise
  // nothing and go looking for something else to be.
  it("propagates an unreachable API server instead of reporting an empty fleet", async () => {
    mockListDeployments.mockRejectedValue(new Error("no cluster"));
    await expect(buildKubernetesManifest()).rejects.toThrow(/no cluster/);
  });
});
