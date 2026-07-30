import { ApiException } from "@kubernetes/client-node";
import type * as k8s from "@kubernetes/client-node";
import type {
  K8sWorkloadKind,
  KubernetesWorkloadIdentity,
  NotFoundResult,
} from "@nightwarden/shared";

export interface ResolvedK8sPod {
  podName: string;
  namespace: string;
  containerName: string | undefined;
  // The pod's own phase, which every Kubernetes read reports so the agent can see
  // whether the evidence came from a healthy pod or a dead one.
  podPhase: string;
  live: boolean;
}

// Kubernetes' own vocabulary for a miss, phrased in Kubernetes' own nouns.
export function noWorkloadResult(
  service: KubernetesWorkloadIdentity,
  reason?: string,
): NotFoundResult {
  return {
    found: false,
    reason:
      reason ??
      `No running pod found for ${service.namespace}/${service.workload}`,
  };
}

// Distinguishes "not this kind, try the next" from a genuine failure (permissions, network) that
// must propagate as-is rather than be masked by the next attempt's unrelated 404.
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

export interface ResolvedWorkloadKind {
  kind: K8sWorkloadKind;
  // Desired replicas: a restart gates on this (a scaled-to-0 workload has nothing
  // to restart), while still allowing a running-but-unhealthy one to be rolled. A
  // DaemonSet's equivalent is how many nodes it is scheduled onto.
  replicas: number;
}

// Resolve the exact kind (or none) in one set of reads, returning kind+replicas, so the caller
// patches the exact resource instead of trying Deployment first and rolling the wrong one on a name clash.
export async function resolveWorkloadKind(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  workload: string,
): Promise<ResolvedWorkloadKind | null> {
  try {
    const d = await appsApi.readNamespacedDeployment({
      name: workload,
      namespace,
    });
    return { kind: "Deployment", replicas: d.spec?.replicas ?? 0 };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  try {
    const s = await appsApi.readNamespacedStatefulSet({
      name: workload,
      namespace,
    });
    return { kind: "StatefulSet", replicas: s.spec?.replicas ?? 0 };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  try {
    const ds = await appsApi.readNamespacedDaemonSet({
      name: workload,
      namespace,
    });
    return {
      kind: "DaemonSet",
      replicas: ds.status?.desiredNumberScheduled ?? 0,
    };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  return null;
}

// Resolve a durable workload identity to the live pod and container at exec time, fail-fast: writes/exec
// require a Running pod; a multi-container pod needs the caller's `container`, else a not-running result lists the choices, never guessing.
export async function resolveWorkload(
  coreApi: k8s.CoreV1Api,
  appsApi: k8s.AppsV1Api,
  namespace: string,
  workload: string,
  opts: { container?: string; requireLive: boolean },
): Promise<ResolvedK8sPod | NotFoundResult> {
  const identity: KubernetesWorkloadIdentity = { namespace, workload };

  const labelSelector = await getWorkloadSelector(appsApi, namespace, workload);
  if (labelSelector === null) return noWorkloadResult(identity);

  const podList = await coreApi.listNamespacedPod({ namespace, labelSelector });
  if (podList.items.length === 0) return noWorkloadResult(identity);

  const livePods = podList.items.filter((p) => p.status?.phase === "Running");
  if (opts.requireLive && livePods.length === 0) {
    return noWorkloadResult(identity);
  }

  const chosen =
    livePods.length > 0 ? newestPod(livePods) : newestPod(podList.items);
  const podName = chosen.metadata?.name ?? "";
  if (!podName) return noWorkloadResult(identity);

  const choice = selectContainer(chosen.spec?.containers ?? [], opts.container);
  if (choice.kind === "ambiguous") {
    return noWorkloadResult(
      identity,
      `Pod ${podName} has multiple containers (${choice.available.join(", ")}); set the "container" field to choose one.`,
    );
  }
  if (choice.kind === "not-found") {
    return noWorkloadResult(
      identity,
      `Container "${opts.container}" is not in pod ${podName}; available: ${choice.available.join(", ")}.`,
    );
  }

  const phase = chosen.status?.phase ?? "Unknown";
  return {
    podName,
    namespace,
    containerName: choice.name,
    podPhase: phase,
    live: phase === "Running",
  };
}

type ContainerChoice =
  | { kind: "ok"; name: string | undefined }
  | { kind: "ambiguous"; available: string[] }
  | { kind: "not-found"; available: string[] };

function selectContainer(
  containers: Array<{ name: string }>,
  requested: string | undefined,
): ContainerChoice {
  const names = containers.map((c) => c.name);
  if (names.length <= 1) return { kind: "ok", name: names[0] };
  if (requested) {
    return names.includes(requested)
      ? { kind: "ok", name: requested }
      : { kind: "not-found", available: names };
  }
  return { kind: "ambiguous", available: names };
}

export async function getWorkloadSelector(
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
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Not a Deployment; try StatefulSet.
  }

  try {
    const sts = await appsApi.readNamespacedStatefulSet({
      name: workload,
      namespace,
    });
    const sel = labelSelectorString(sts.spec?.selector ?? {});
    if (sel) return sel;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Not a StatefulSet; try DaemonSet.
  }

  try {
    const ds = await appsApi.readNamespacedDaemonSet({
      name: workload,
      namespace,
    });
    const sel = labelSelectorString(ds.spec?.selector ?? {});
    if (sel) return sel;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // None of the three kinds.
  }

  // The name matches no workload we manage; caller returns a not-found finding
  // rather than a guessed selector.
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
