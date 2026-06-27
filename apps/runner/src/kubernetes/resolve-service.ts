import { ApiException } from "@kubernetes/client-node";
import type * as k8s from "@kubernetes/client-node";
import type {
  KubernetesServiceIdentity,
  ServiceIdentity,
} from "@nightwatch/shared";
import {
  notRunningResult,
  type NoRunningInstanceResult,
} from "../resolve-result.js";

export interface ResolvedK8sPod {
  podName: string;
  namespace: string;
  containerName: string | undefined;
  live: boolean;
}

export { notRunningResult, type NoRunningInstanceResult };

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

// Distinguishes "not this kind, try the next" from a genuine failure
// (permissions, network) that must propagate as-is rather than be masked by the
// next attempt's unrelated 404 (ADR-0002, user story 9).
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

export interface ResolvedWorkloadKind {
  kind: "Deployment" | "StatefulSet";
  // Desired replicas: a restart gates on this (a scaled-to-0 workload has nothing
  // to restart), while still allowing a running-but-unhealthy one to be rolled.
  replicas: number;
}

// Resolves whether a workload is a Deployment or a StatefulSet (or neither) in
// one set of reads, returning the kind and desired replicas, so the caller
// patches the exact resource instead of blindly trying Deployment first and
// falling back on a 404 - which rolls the wrong resource when both kinds share
// a name.
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
  return null;
}

// Translates a durable workload identity to the live pod and target container at
// execution time (ADR-0001). Deterministic and fail-fast: a read may fall back
// to the most recent terminated pod (post-crash log reads), but a write/exec
// (requireLive) requires a Running pod rather than execing into a corpse. The
// container is chosen explicitly - a single-container pod is unambiguous; a
// multi-container pod requires the caller's `container` to name one, otherwise
// it returns a not-running result listing the choices rather than silently
// targeting the first (which is often a sidecar).
export async function resolveWorkload(
  coreApi: k8s.CoreV1Api,
  appsApi: k8s.AppsV1Api,
  namespace: string,
  workload: string,
  opts: { container?: string; requireLive: boolean },
): Promise<ResolvedK8sPod | NoRunningInstanceResult> {
  const identity: KubernetesServiceIdentity = {
    provider: "kubernetes",
    namespace,
    workload,
  };

  const labelSelector = await getWorkloadSelector(appsApi, namespace, workload);
  if (labelSelector === null) return notRunningResult(identity);

  const podList = await coreApi.listNamespacedPod({ namespace, labelSelector });
  if (podList.items.length === 0) return notRunningResult(identity);

  const livePods = podList.items.filter((p) => p.status?.phase === "Running");
  if (opts.requireLive && livePods.length === 0) {
    return notRunningResult(identity);
  }

  const chosen =
    livePods.length > 0 ? newestPod(livePods) : newestPod(podList.items);
  const podName = chosen.metadata?.name ?? "";
  if (!podName) return notRunningResult(identity);

  const choice = selectContainer(chosen.spec?.containers ?? [], opts.container);
  if (choice.kind === "ambiguous") {
    return notRunningResult(
      identity,
      `Pod ${podName} has multiple containers (${choice.available.join(", ")}); set the service's "container" field to choose one.`,
    );
  }
  if (choice.kind === "not-found") {
    return notRunningResult(
      identity,
      `Container "${opts.container}" is not in pod ${podName}; available: ${choice.available.join(", ")}.`,
    );
  }

  return {
    podName,
    namespace,
    containerName: choice.name,
    live: chosen.status?.phase === "Running",
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
    // Not a StatefulSet either.
  }

  // The workload is neither a Deployment nor a StatefulSet; caller returns a
  // not-running finding rather than a guessed selector.
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
