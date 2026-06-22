import type * as k8s from "@kubernetes/client-node";
import type {
  KubernetesServiceIdentity,
  ServiceIdentity,
} from "@nightwatch/shared";

export interface ResolvedK8sPod {
  podName: string;
  namespace: string;
  containerName: string | undefined;
  live: boolean;
}

export interface NoRunningInstanceResult {
  found: false;
  reason: string;
}

// A non-kubernetes identity reaching a Kubernetes runner is a routing/model
// bug, not a missing-pod finding (ADR-0002).
export function requireK8sIdentity(
  service: ServiceIdentity,
): KubernetesServiceIdentity {
  if (service.provider !== "kubernetes") {
    throw new Error(
      `This runner only supports Kubernetes; received a '${service.provider}' service identity.`,
    );
  }
  return service;
}

export function notRunningResult(
  service: ServiceIdentity,
): NoRunningInstanceResult {
  const label =
    service.provider === "kubernetes"
      ? `${service.namespace}/${service.workload}`
      : `${service.project}/${service.service}`;
  return { found: false, reason: `No running instance found for ${label}` };
}

// Translates a durable workload identity to the live pod at execution time
// (ADR-0001). Prefers running pods; falls back to the most recently created
// terminated pod so that log reads still work after a crash.
export async function resolveWorkload(
  coreApi: k8s.CoreV1Api,
  appsApi: k8s.AppsV1Api,
  namespace: string,
  workload: string,
): Promise<ResolvedK8sPod | null> {
  const labelSelector = await getWorkloadSelector(appsApi, namespace, workload);
  if (labelSelector === null) return null;
  const podList = await coreApi.listNamespacedPod({ namespace, labelSelector });

  if (podList.items.length === 0) return null;

  const livePods = podList.items.filter((p) => p.status?.phase === "Running");
  const chosen =
    livePods.length > 0 ? newestPod(livePods) : newestPod(podList.items);

  const podName = chosen.metadata?.name ?? "";
  if (!podName) return null;

  return {
    podName,
    namespace,
    containerName: chosen.spec?.containers?.[0]?.name,
    live: chosen.status?.phase === "Running",
  };
}

async function getWorkloadSelector(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  workload: string,
): Promise<string | null> {
  try {
    const deployment = await appsApi.readNamespacedDeployment({
      name: workload,
      namespace,
    });
    const sel = labelSelectorString(deployment.spec?.selector ?? {});
    if (sel) return sel;
  } catch {
    // Not a Deployment; try StatefulSet.
  }

  try {
    const sts = await appsApi.readNamespacedStatefulSet({
      name: workload,
      namespace,
    });
    const sel = labelSelectorString(sts.spec?.selector ?? {});
    if (sel) return sel;
  } catch {
    // Not a StatefulSet either.
  }

  // The workload is neither a Deployment nor a StatefulSet; caller returns null
  // which surfaces as a not-running finding rather than a guessed selector.
  return null;
}

function labelSelectorString(selector: k8s.V1LabelSelector): string {
  const parts: string[] = [];

  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) {
    parts.push(`${k}=${v}`);
  }

  for (const expr of selector.matchExpressions ?? []) {
    switch (expr.operator) {
      case "In":
        parts.push(`${expr.key} in (${(expr.values ?? []).join(",")})`);
        break;
      case "NotIn":
        parts.push(`${expr.key} notin (${(expr.values ?? []).join(",")})`);
        break;
      case "Exists":
        parts.push(expr.key);
        break;
      case "DoesNotExist":
        parts.push(`!${expr.key}`);
        break;
    }
  }

  return parts.join(",");
}

function newestPod(pods: k8s.V1Pod[]): k8s.V1Pod {
  return pods.reduce((newest, p) => {
    const t = new Date(p.metadata?.creationTimestamp ?? 0).getTime();
    const nt = new Date(newest.metadata?.creationTimestamp ?? 0).getTime();
    return t > nt ? p : newest;
  });
}
