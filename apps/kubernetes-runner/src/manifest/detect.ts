import { hostname } from "node:os";
import {
  kubernetesWorkloadKey,
  type K8sWorkloadKind,
  type KubernetesManifest,
  type KubernetesWorkloadEntry,
} from "@nightwarden/shared";
import { getAppsV1Api } from "../kubernetes/client.js";

// The root package.json version, inlined at build time. "dev" under tsx, which
// runs from source and so has no build step to inline anything.
const RUNNER_VERSION = process.env.NW_VERSION ?? "dev";

// No probing: this binary is a Kubernetes runner, so an unreachable API server is a
// failure to report, not a reason to go looking for something else to be.
export async function buildKubernetesManifest(): Promise<KubernetesManifest> {
  return {
    platform: "kubernetes",
    // One pod on one arbitrary node, so this names the pod rather than a machine an
    // user would recognise. The display name from onboarding is what addresses it.
    hostname: hostname(),
    runnerVersion: RUNNER_VERSION,
    services: await listWorkloads(),
  };
}

async function listWorkloads(): Promise<KubernetesWorkloadEntry[]> {
  const appsApi = getAppsV1Api();
  const [deployments, statefulSets, daemonSets] = await Promise.all([
    appsApi.listDeploymentForAllNamespaces(),
    appsApi.listStatefulSetForAllNamespaces(),
    appsApi.listDaemonSetForAllNamespaces(),
  ]);

  // The three kinds report readiness under different names, so the manifest reads
  // only the fields all three share plus each one's own readiness count.
  interface WorkloadListing {
    metadata?: { namespace?: string; name?: string };
    status?: { readyReplicas?: number; numberReady?: number };
  }
  const kinds: Array<[K8sWorkloadKind, WorkloadListing[]]> = [
    ["Deployment", deployments.items],
    ["StatefulSet", statefulSets.items],
    ["DaemonSet", daemonSets.items],
  ];

  const byKey = new Map<string, KubernetesWorkloadEntry>();
  for (const [kind, items] of kinds) {
    for (const item of items) {
      const namespace = item.metadata?.namespace ?? "default";
      const workload = item.metadata?.name ?? "";
      if (!workload) continue;
      // A workload with nothing ready is advertised as stopped, not running, so
      // routing and the snapshot don't treat a scaled-to-0 service as up. A
      // DaemonSet counts nodes, so its readiness lives under another name.
      const ready =
        (item.status?.readyReplicas ?? item.status?.numberReady ?? 0) > 0;
      const identity = { namespace, workload };
      byKey.set(`${namespace}/${workload}`, {
        identity,
        target: kubernetesWorkloadKey(identity),
        status: ready ? "running" : "stopped",
        kind,
      });
    }
  }
  return [...byKey.values()];
}
