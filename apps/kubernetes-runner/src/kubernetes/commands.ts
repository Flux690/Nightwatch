import { PassThrough } from "node:stream";
import { setHeaderOptions } from "@kubernetes/client-node";
import type * as k8s from "@kubernetes/client-node";
import { kubernetesWorkloadKey } from "@nightwarden/shared";
import type {
  K8sBashInput,
  K8sBashResult,
  K8sConfigInput,
  K8sConfigResult,
  K8sContainerSpec,
  K8sContainerStats,
  K8sEvent,
  K8sEventsInput,
  K8sEventsResult,
  K8sLogsInput,
  K8sLogsResult,
  K8sNodeStatusResult,
  K8sPodStats,
  K8sProbe,
  K8sProcess,
  K8sProcessesInput,
  K8sProcessesResult,
  K8sRestartInput,
  K8sRestartResult,
  K8sRolloutStatusInput,
  K8sRolloutStatusResult,
  K8sStatsInput,
  K8sStatsResult,
  K8sWorkloadInstance,
  K8sWorkloadKind,
  K8sWorkloadListInput,
  K8sWorkloadListResult,
  NotFoundResult,
} from "@nightwarden/shared";
import { getCoreV1Api, getAppsV1Api, getMetrics, getExec } from "./client.js";
import {
  resolveWorkload,
  resolveWorkloadKind,
  getWorkloadSelector,
  isNotFoundError,
  noWorkloadResult,
} from "./resolve-workload.js";
import { sanitize, sanitizeLines } from "@nightwarden/runner-transport";

// kubectl rollout restart sends this Content-Type so the server merges the annotation into
// spec.template.metadata.annotations instead of interpreting the body as a JSON Patch operation array (the client's default for PATCH).
const STRATEGIC_MERGE_PATCH_OPTIONS = setHeaderOptions(
  "Content-Type",
  "application/strategic-merge-patch+json",
);

// A workload with many replicas would otherwise bury the one that matters; the
// count of what was dropped keeps the omission visible.
const MAX_PODS_REPORTED = 20;
const MAX_EVENTS_REPORTED = 100;
const DEFAULT_TAIL_LINES = 200;

// Plain text on whole lines, deliberately not a pattern: an agent-written regex
// over thousands of lines is a backtracking hazard this runner would wear.
// Case-insensitive, because ERROR and error are the same word to whoever asked.
function matchesFilter(
  line: string,
  contains: string[],
  excludes: string[],
): boolean {
  const haystack = line.toLowerCase();
  const hits = (term: string): boolean => haystack.includes(term.toLowerCase());
  if (excludes.some(hits)) return false;
  return contains.length === 0 || contains.some(hits);
}

/* What the count means, which is not what it looks like: the tail is applied by
   the apiserver before any filtering, so a small number of matches is a fact
   about the lines searched and never about the log. */
function logScanNote(
  scanned: number,
  matched: number,
  tailLines: number,
  scanHitTail: boolean,
): string {
  if (scanned === matched && !scanHitTail) return "";
  const reach = scanHitTail
    ? `the newest ${scanned} lines, which filled the ${tailLines}-line scan, so older lines were not searched`
    : `all ${scanned} lines available`;
  return matched === scanned
    ? `Searched ${reach}.`
    : `${matched} of ${scanned} lines matched your filter. Searched ${reach}. A line absent here was not necessarily absent from the log.`;
}

// List workloads, not pods, so the identity matches the manifest byte-for-byte; a pod-label identity
// diverged, so a listed service couldn't be resolved back and the audit record mis-keyed it.
export async function listWorkloads(
  input: K8sWorkloadListInput,
): Promise<K8sWorkloadListResult> {
  const namespace = input.namespace ?? "default";
  const appsApi = getAppsV1Api();

  const [deployments, statefulSets, daemonSets] = await Promise.all([
    appsApi.listNamespacedDeployment({ namespace }),
    appsApi.listNamespacedStatefulSet({ namespace }),
    appsApi.listNamespacedDaemonSet({ namespace }),
  ]);

  const workloads: K8sWorkloadInstance[] = [
    ...deployments.items.map((obj) =>
      describeInstance({ kind: "Deployment", obj }, namespace),
    ),
    ...statefulSets.items.map((obj) =>
      describeInstance({ kind: "StatefulSet", obj }, namespace),
    ),
    ...daemonSets.items.map((obj) =>
      describeInstance({ kind: "DaemonSet", obj }, namespace),
    ),
  ];

  return { workloads };
}

export async function getWorkloadLogs(
  input: K8sLogsInput,
): Promise<K8sLogsResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const resolved = await resolveWorkload(
    coreApi,
    appsApi,
    service.namespace,
    service.workload,
    { container: service.container, requireLive: false },
  );
  if ("found" in resolved) return resolved;

  // When the resolved pod is not live we fell back to a terminated instance (a crash-loop's dead
  // container); its useful output lives in the previous container, so request that rather than the empty current one.
  const fromPreviousContainer = !resolved.live;

  const tailLines = input.tailLines ?? DEFAULT_TAIL_LINES;
  const log = await coreApi.readNamespacedPodLog({
    name: resolved.podName,
    namespace: resolved.namespace,
    container: resolved.containerName,
    tailLines,
    previous: fromPreviousContainer,
    ...(input.since !== undefined && {
      sinceSeconds: Math.max(
        1,
        Math.floor((Date.now() - new Date(input.since).getTime()) / 1000),
      ),
    }),
  });

  // Redacted where the raw text enters, so every count below describes what is
  // actually returned rather than what the pod emitted.
  const scanned = sanitizeLines(log.split("\n").filter(Boolean));
  const lines = scanned.filter((line) =>
    matchesFilter(line, input.contains ?? [], input.excludes ?? []),
  );
  const scanHitTail = scanned.length >= tailLines;

  return {
    lines,
    scannedLines: scanned.length,
    scanHitTail,
    note: logScanNote(scanned.length, lines.length, tailLines, scanHitTail),
    podName: resolved.podName,
    containerName: resolved.containerName ?? null,
    podPhase: resolved.podPhase,
    fromPreviousContainer,
  };
}

// The workload's own spec, never a pod's: the pod is an instance of this, and the
// question "how is it configured" is answered by the thing that owns the template.
export async function describeWorkload(
  input: K8sConfigInput,
): Promise<K8sConfigResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const found = await readWorkload(
    appsApi,
    service.namespace,
    service.workload,
  );
  if (found === null) return noWorkloadResult(input.service);
  const { kind, meta, spec, status } = found;

  const template = spec?.template;
  const podSpec = template?.spec;

  // A digest exists only on a running pod's containerStatuses, never in a spec, so
  // it is null until something is actually running.
  const digests = await imageDigestsFor(
    coreApi,
    service.namespace,
    labelSelectorOf(spec?.selector),
  );

  return {
    name: meta?.name ?? service.workload,
    kind,
    namespace: meta?.namespace ?? service.namespace,
    createdAt: meta?.creationTimestamp
      ? new Date(meta.creationTimestamp).toISOString()
      : "",
    generation: meta?.generation ?? 0,
    observedGeneration: status?.observedGeneration ?? 0,
    desiredReplicas: desiredOf(found),
    strategy: strategyOf(found),
    selector: spec?.selector?.matchLabels ?? {},
    serviceAccountName: podSpec?.serviceAccountName ?? null,
    nodeSelector: podSpec?.nodeSelector ?? {},
    containers: (podSpec?.containers ?? []).map((c) =>
      containerSpec(c, digests.get(c.name) ?? null),
    ),
    volumes: (podSpec?.volumes ?? []).map((v) => ({
      name: v.name,
      kind: volumeKind(v),
    })),
  };
}

// Every pod of the workload, not one: a single crash-looping replica among healthy
// ones is exactly the finding, and reading one pod would hide it.
export async function getWorkloadStats(
  input: K8sStatsInput,
): Promise<K8sStatsResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const labelSelector = await getWorkloadSelector(
    appsApi,
    service.namespace,
    service.workload,
  );
  if (labelSelector === null) return noWorkloadResult(input.service);

  const podList = await coreApi.listNamespacedPod({
    namespace: service.namespace,
    labelSelector,
  });
  if (podList.items.length === 0) return noWorkloadResult(input.service);

  // A cluster without metrics-server is a common configuration, not a failure: the
  // requests, limits and restart counts below are the useful half and need no metrics.
  let usageByPod = new Map<string, Map<string, k8s.Usage>>();
  let metricsAvailable = true;
  try {
    const metrics = await getMetrics().getPodMetrics(service.namespace);
    usageByPod = new Map(
      metrics.items.map((m) => [
        m.metadata.name,
        new Map(m.containers.map((c) => [c.name, c.usage])),
      ]),
    );
  } catch {
    metricsAvailable = false;
  }

  const shown = podList.items.slice(0, MAX_PODS_REPORTED);
  const omitted = podList.items.length - shown.length;

  const pods: K8sPodStats[] = shown.map((pod) => {
    const podName = pod.metadata?.name ?? "";
    const usage = usageByPod.get(podName);
    const statuses = new Map(
      (pod.status?.containerStatuses ?? []).map((s) => [s.name, s]),
    );
    return {
      podName,
      phase: pod.status?.phase ?? "Unknown",
      nodeName: pod.spec?.nodeName ?? null,
      startedAt: pod.status?.startTime
        ? new Date(pod.status.startTime).toISOString()
        : null,
      containers: (pod.spec?.containers ?? []).map((c) =>
        containerStats(c, statuses.get(c.name), usage?.get(c.name)),
      ),
    };
  });

  return {
    workload: service.workload,
    namespace: service.namespace,
    metricsAvailable,
    pods,
    ...(omitted > 0 && { podsOmitted: omitted }),
  };
}

// The workload's own events AND its pods': a failing rollout reports on the
// controller, a failing image pull on the pod, and an investigation needs both.
export async function getWorkloadEvents(
  input: K8sEventsInput,
): Promise<K8sEventsResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const labelSelector = await getWorkloadSelector(
    appsApi,
    service.namespace,
    service.workload,
  );
  if (labelSelector === null) return noWorkloadResult(input.service);

  const podList = await coreApi.listNamespacedPod({
    namespace: service.namespace,
    labelSelector,
  });
  const subjects = new Set<string>([service.workload]);
  for (const pod of podList.items) {
    const name = pod.metadata?.name;
    if (name) subjects.add(name);
  }

  // One listing filtered client-side: a fieldSelector matches a single object name,
  // and this needs the union of the controller and every one of its pods.
  const events = await coreApi.listNamespacedEvent({
    namespace: service.namespace,
  });

  const warningsOnly = input.warningsOnly ?? true;
  const cutoff = Date.now() - (input.sinceMinutes ?? 60) * 60_000;

  const matched = events.items
    .filter((e) => subjects.has(e.involvedObject.name ?? ""))
    .filter((e) => !warningsOnly || e.type === "Warning")
    .filter((e) => eventTime(e) >= cutoff)
    .sort((a, b) => eventTime(a) - eventTime(b));

  const shown = matched.slice(-MAX_EVENTS_REPORTED);
  const omitted = matched.length - shown.length;

  return {
    workload: service.workload,
    namespace: service.namespace,
    events: shown.map(normalizeEvent),
    ...(omitted > 0 && { eventsOmitted: omitted }),
    warningsOnly,
  };
}

export async function getWorkloadProcesses(
  input: K8sProcessesInput,
): Promise<K8sProcessesResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const resolved = await resolveWorkload(
    coreApi,
    appsApi,
    service.namespace,
    service.workload,
    { container: service.container, requireLive: true },
  );
  if ("found" in resolved) return resolved;

  const { stdout } = await execInPod(
    resolved.namespace,
    resolved.podName,
    resolved.containerName ?? "",
    ["ps", "-eo", "pid,ppid,user,pcpu,pmem,comm", "--no-headers"],
  );

  const processes: K8sProcess[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parsePsLine);

  return {
    podName: resolved.podName,
    containerName: resolved.containerName ?? null,
    processes,
  };
}

// Rolls via a restartedAt annotation, never deleting pods directly; the exact kind is
// resolved first so a same-named Deployment/StatefulSet/DaemonSet can't be confused.
export async function restartWorkload(
  input: K8sRestartInput,
): Promise<K8sRestartResult | NotFoundResult> {
  const service = input.service;
  const appsApi = getAppsV1Api();

  const workload = await resolveWorkloadKind(
    appsApi,
    service.namespace,
    service.workload,
  );
  // A missing or scaled-to-0 workload has nothing to roll; a running-but-unhealthy
  // one is still restartable - that's the case you most want to fix.
  if (workload === null || workload.replicas === 0) {
    return noWorkloadResult(input.service);
  }

  const startedAt = new Date().toISOString();
  const body = {
    spec: {
      template: {
        metadata: {
          annotations: { "kubectl.kubernetes.io/restartedAt": startedAt },
        },
      },
    },
  };
  const args = { name: service.workload, namespace: service.namespace, body };

  const patched =
    workload.kind === "Deployment"
      ? await appsApi.patchNamespacedDeployment(
          args,
          STRATEGIC_MERGE_PATCH_OPTIONS,
        )
      : workload.kind === "StatefulSet"
        ? await appsApi.patchNamespacedStatefulSet(
            args,
            STRATEGIC_MERGE_PATCH_OPTIONS,
          )
        : await appsApi.patchNamespacedDaemonSet(
            args,
            STRATEGIC_MERGE_PATCH_OPTIONS,
          );

  return {
    success: true,
    startedAt,
    kind: workload.kind,
    generation: patched.metadata?.generation ?? 0,
  };
}

export async function execInWorkload(
  input: K8sBashInput,
): Promise<K8sBashResult | NotFoundResult> {
  const service = input.service;
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  const resolved = await resolveWorkload(
    coreApi,
    appsApi,
    service.namespace,
    service.workload,
    { container: service.container, requireLive: true },
  );
  if ("found" in resolved) return resolved;

  const [cmd, ...args] = input.command;
  if (!cmd) throw new Error("command array must not be empty");

  const executedAt = new Date().toISOString();
  const { stdout, stderr, exitCode } = await execInPod(
    resolved.namespace,
    resolved.podName,
    resolved.containerName ?? "",
    [cmd, ...args],
  );

  return {
    exitCode,
    stdout: sanitize(stdout),
    stderr: sanitize(stderr),
    executedAt,
    podName: resolved.podName,
    containerName: resolved.containerName ?? null,
  };
}

// Kubernetes-only: rollout state has no Docker equivalent, so it's never offered to
// Docker-only fleets.
export async function getRolloutStatus(
  input: K8sRolloutStatusInput,
): Promise<K8sRolloutStatusResult | NotFoundResult> {
  const service = input.service;
  const appsApi = getAppsV1Api();

  const parts = await readWorkload(
    appsApi,
    service.namespace,
    service.workload,
  );
  if (parts === null) return noWorkloadResult(input.service);
  const { kind, meta, status, found } = parts;

  const counts = replicaCounts(parts);
  const generation = meta?.generation ?? 0;
  const observedGeneration = status?.observedGeneration ?? 0;

  const stale = observedGeneration < generation;
  const complete =
    !stale &&
    counts.desired > 0 &&
    counts.updated === counts.desired &&
    counts.ready === counts.desired &&
    counts.available === counts.desired;

  return {
    workload: service.workload,
    namespace: service.namespace,
    kind,
    complete,
    reason: rolloutReason(stale, counts),
    desiredReplicas: counts.desired,
    updatedReplicas: counts.updated,
    readyReplicas: counts.ready,
    availableReplicas: counts.available,
    generation,
    observedGeneration,
    // Only a StatefulSet tracks revisions; the other two kinds have no equivalent.
    currentRevision:
      found.kind === "StatefulSet"
        ? (found.obj.status?.currentRevision ?? null)
        : null,
    updateRevision:
      found.kind === "StatefulSet"
        ? (found.obj.status?.updateRevision ?? null)
        : null,
    conditions: (status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason ?? "",
      message: c.message ?? "",
      lastTransitionTime: c.lastTransitionTime
        ? new Date(c.lastTransitionTime).toISOString()
        : null,
    })),
  };
}

// An unhealthy pod's cause may be the node; no service identity here since
// pressure is a node fact, not a per-workload one.
export async function getNodeStatus(): Promise<K8sNodeStatusResult> {
  const coreApi = getCoreV1Api();
  const nodeList = await coreApi.listNode();

  const nodes = nodeList.items.map((node) => {
    const conditions = node.status?.conditions ?? [];
    const ready = conditions.find((c) => c.type === "Ready");
    return {
      name: node.metadata?.name ?? "",
      ready: ready?.status === "True",
      unschedulable: node.spec?.unschedulable === true,
      conditions: conditions.map((c) => ({
        type: c.type,
        status: conditionStatus(c.status),
        reason: c.reason ?? null,
        message: c.message ?? null,
        lastTransitionTime: c.lastTransitionTime
          ? new Date(c.lastTransitionTime).toISOString()
          : null,
      })),
      allocatable: resourceTriple(node.status?.allocatable),
      capacity: resourceTriple(node.status?.capacity),
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? null,
    };
  });

  return { nodes };
}

// One shape for the three kinds, so every caller below reads replica counts,
// strategy and status from the same place instead of branching three ways.
type FoundWorkload =
  | { kind: "Deployment"; obj: k8s.V1Deployment }
  | { kind: "StatefulSet"; obj: k8s.V1StatefulSet }
  | { kind: "DaemonSet"; obj: k8s.V1DaemonSet };

interface WorkloadParts {
  kind: K8sWorkloadKind;
  meta: k8s.V1ObjectMeta | undefined;
  spec:
    | k8s.V1DeploymentSpec
    | k8s.V1StatefulSetSpec
    | k8s.V1DaemonSetSpec
    | undefined;
  status:
    | (k8s.V1DeploymentStatus & Partial<k8s.V1StatefulSetStatus>)
    | k8s.V1StatefulSetStatus
    | k8s.V1DaemonSetStatus
    | undefined;
  found: FoundWorkload;
}

async function readWorkload(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  name: string,
): Promise<WorkloadParts | null> {
  const attempts: Array<() => Promise<FoundWorkload>> = [
    async () => ({
      kind: "Deployment",
      obj: await appsApi.readNamespacedDeployment({ name, namespace }),
    }),
    async () => ({
      kind: "StatefulSet",
      obj: await appsApi.readNamespacedStatefulSet({ name, namespace }),
    }),
    async () => ({
      kind: "DaemonSet",
      obj: await appsApi.readNamespacedDaemonSet({ name, namespace }),
    }),
  ];

  for (const attempt of attempts) {
    try {
      const found = await attempt();
      return {
        kind: found.kind,
        meta: found.obj.metadata,
        spec: found.obj.spec,
        status: found.obj.status,
        found,
      };
    } catch (err) {
      // Distinguishes "not this kind, try the next" from a genuine failure
      // (permissions, network), which must propagate rather than be masked.
      if (!isNotFoundError(err)) throw err;
    }
  }
  return null;
}

interface ReplicaCounts {
  desired: number;
  ready: number;
  updated: number;
  available: number;
}

// A DaemonSet counts nodes rather than replicas, so its four numbers live under
// different names; mapping them here is what lets one status rule serve all three.
function replicaCounts(parts: WorkloadParts): ReplicaCounts {
  const { found } = parts;
  if (found.kind === "DaemonSet") {
    const s = found.obj.status;
    return {
      desired: s?.desiredNumberScheduled ?? 0,
      ready: s?.numberReady ?? 0,
      updated: s?.updatedNumberScheduled ?? 0,
      available: s?.numberAvailable ?? 0,
    };
  }
  const s = found.obj.status;
  return {
    desired: found.obj.spec?.replicas ?? 0,
    ready: s?.readyReplicas ?? 0,
    updated: s?.updatedReplicas ?? 0,
    available: s?.availableReplicas ?? 0,
  };
}

function desiredOf(parts: WorkloadParts): number {
  return replicaCounts(parts).desired;
}

function workloadStatus(
  counts: ReplicaCounts,
  generation: number,
  observedGeneration: number,
): K8sWorkloadInstance["status"] {
  if (counts.desired === 0) return "ScaledToZero";
  if (observedGeneration < generation || counts.updated < counts.desired) {
    return "Progressing";
  }
  return counts.ready === counts.desired ? "Healthy" : "Degraded";
}

function rolloutReason(stale: boolean, counts: ReplicaCounts): string {
  if (stale) return "the controller has not yet observed the latest change";
  if (counts.desired === 0) return "scaled to zero";
  if (counts.updated < counts.desired) {
    return `${counts.updated} of ${counts.desired} replicas updated`;
  }
  if (counts.ready < counts.desired) {
    return `${counts.ready} of ${counts.desired} replicas ready`;
  }
  if (counts.available < counts.desired) {
    return `${counts.available} of ${counts.desired} replicas available`;
  }
  return "rollout complete";
}

function describeInstance(
  found: FoundWorkload,
  fallbackNamespace: string,
): K8sWorkloadInstance {
  const { kind, obj } = found;
  // Re-uses the shared reader so a listed workload reports the same numbers a
  // rollout-status read of the same object would.
  const counts = replicaCounts({
    kind,
    meta: obj.metadata,
    spec: obj.spec,
    status: obj.status,
    found,
  });
  const name = obj.metadata?.name ?? "";
  const namespace = obj.metadata?.namespace ?? fallbackNamespace;
  const image = obj.spec?.template?.spec?.containers?.[0]?.image ?? "";
  const generation = obj.metadata?.generation ?? 0;
  const observedGeneration = obj.status?.observedGeneration ?? 0;

  return {
    name,
    kind,
    namespace,
    target: kubernetesWorkloadKey({ namespace, workload: name }),
    uid: obj.metadata?.uid ?? "",
    image,
    imageTag: parseImageTag(image),
    desiredReplicas: counts.desired,
    readyReplicas: counts.ready,
    updatedReplicas: counts.updated,
    availableReplicas: counts.available,
    status: workloadStatus(counts, generation, observedGeneration),
    generation,
    observedGeneration,
  };
}

function strategyOf(parts: WorkloadParts): K8sConfigResult["strategy"] {
  const { found } = parts;
  if (found.kind === "Deployment") {
    const s = found.obj.spec?.strategy;
    return {
      type: s?.type ?? "",
      maxSurge: intOrString(s?.rollingUpdate?.maxSurge),
      maxUnavailable: intOrString(s?.rollingUpdate?.maxUnavailable),
    };
  }
  if (found.kind === "StatefulSet") {
    const s = found.obj.spec?.updateStrategy;
    return {
      type: s?.type ?? "",
      // A StatefulSet replaces pods in place and never surges.
      maxSurge: null,
      maxUnavailable: intOrString(s?.rollingUpdate?.maxUnavailable),
    };
  }
  const s = found.obj.spec?.updateStrategy;
  return {
    type: s?.type ?? "",
    maxSurge: intOrString(s?.rollingUpdate?.maxSurge),
    maxUnavailable: intOrString(s?.rollingUpdate?.maxUnavailable),
  };
}

function intOrString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function containerSpec(
  c: k8s.V1Container,
  imageDigest: string | null,
): K8sContainerSpec {
  const probes: K8sProbe[] = [];
  for (const [kind, probe] of [
    ["liveness", c.livenessProbe],
    ["readiness", c.readinessProbe],
    ["startup", c.startupProbe],
  ] as const) {
    if (probe) probes.push(normalizeProbe(kind, probe));
  }

  return {
    name: c.name,
    image: c.image ?? "",
    imageDigest,
    envVarNames: (c.env ?? []).flatMap((e) => (e.name ? [e.name] : [])),
    // Names only: a Secret's or ConfigMap's contents are never read, so a config
    // read cannot leak a credential.
    envFromSources: (c.envFrom ?? []).flatMap((f) => {
      const name = f.configMapRef?.name ?? f.secretRef?.name;
      return name ? [name] : [];
    }),
    cpuRequest: c.resources?.requests?.["cpu"] ?? null,
    cpuLimit: c.resources?.limits?.["cpu"] ?? null,
    memoryRequest: c.resources?.requests?.["memory"] ?? null,
    memoryLimit: c.resources?.limits?.["memory"] ?? null,
    probes,
    volumeMounts: (c.volumeMounts ?? []).map((m) => ({
      name: m.name,
      mountPath: m.mountPath,
      readOnly: m.readOnly ?? false,
    })),
  };
}

function normalizeProbe(kind: K8sProbe["kind"], probe: k8s.V1Probe): K8sProbe {
  const [type, detail] = probeTarget(probe);
  return {
    kind,
    type,
    detail,
    initialDelaySeconds: probe.initialDelaySeconds ?? 0,
    periodSeconds: probe.periodSeconds ?? 10,
    timeoutSeconds: probe.timeoutSeconds ?? 1,
    failureThreshold: probe.failureThreshold ?? 3,
    successThreshold: probe.successThreshold ?? 1,
  };
}

function probeTarget(probe: k8s.V1Probe): [K8sProbe["type"], string] {
  if (probe.httpGet) {
    const { path, port, scheme } = probe.httpGet;
    return [
      "http",
      `${scheme ?? "HTTP"} ${path ?? "/"} on port ${String(port)}`,
    ];
  }
  if (probe.tcpSocket) return ["tcp", `port ${String(probe.tcpSocket.port)}`];
  if (probe.exec) return ["exec", (probe.exec.command ?? []).join(" ")];
  if (probe.grpc) return ["grpc", `port ${String(probe.grpc.port)}`];
  return ["exec", ""];
}

function volumeKind(volume: k8s.V1Volume): string {
  // The source is whichever single field other than `name` is set; reporting its
  // name tells the agent whether a mount is a Secret, a PVC or an emptyDir.
  for (const [key, value] of Object.entries(volume)) {
    if (key !== "name" && value !== undefined && value !== null) return key;
  }
  return "unknown";
}

async function imageDigestsFor(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  labelSelector: string | null,
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  if (labelSelector === null) return digests;

  const pods = await coreApi.listNamespacedPod({ namespace, labelSelector });
  const running = pods.items.filter((p) => p.status?.phase === "Running");
  const source = running[0] ?? pods.items[0];
  for (const status of source?.status?.containerStatuses ?? []) {
    if (status.imageID) digests.set(status.name, status.imageID);
  }
  return digests;
}

function labelSelectorOf(
  selector: k8s.V1LabelSelector | undefined,
): string | null {
  const parts = Object.entries(selector?.matchLabels ?? {}).map(
    ([k, v]) => `${k}=${v}`,
  );
  return parts.length > 0 ? parts.join(",") : null;
}

function containerStats(
  spec: k8s.V1Container,
  status: k8s.V1ContainerStatus | undefined,
  usage: k8s.Usage | undefined,
): K8sContainerStats {
  const terminated = status?.lastState?.terminated;
  return {
    name: spec.name,
    cpuMillicores: parseCpuMillicores(usage?.cpu),
    memoryBytes: parseMemoryBytes(usage?.memory),
    cpuRequestMillicores: parseCpuMillicores(spec.resources?.requests?.["cpu"]),
    cpuLimitMillicores: parseCpuMillicores(spec.resources?.limits?.["cpu"]),
    memoryRequestBytes: parseMemoryBytes(spec.resources?.requests?.["memory"]),
    memoryLimitBytes: parseMemoryBytes(spec.resources?.limits?.["memory"]),
    restartCount: status?.restartCount ?? 0,
    // "OOMKilled" here is the answer to a whole class of investigation.
    lastTerminationReason: terminated?.reason ?? null,
    lastTerminationExitCode: terminated?.exitCode ?? null,
  };
}

// Kubernetes quantities are strings with a unit suffix, and metrics-server reports
// CPU in nanocores, so a raw Number() would be wrong by six orders of magnitude.
const CPU_MILLI_SCALE: Record<string, number> = {
  "": 1000,
  n: 1e-6,
  u: 1e-3,
  m: 1,
};

const MEMORY_BYTE_SCALE: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

function parseQuantity(
  quantity: string | undefined,
  scales: Record<string, number>,
): number | null {
  if (quantity === undefined) return null;
  const match = /^([0-9.]+)([A-Za-z]*)$/.exec(quantity.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const scale = scales[match[2] ?? ""];
  if (!Number.isFinite(value) || scale === undefined) return null;
  return Math.round(value * scale);
}

export function parseCpuMillicores(
  quantity: string | undefined,
): number | null {
  return parseQuantity(quantity, CPU_MILLI_SCALE);
}

export function parseMemoryBytes(quantity: string | undefined): number | null {
  return parseQuantity(quantity, MEMORY_BYTE_SCALE);
}

function eventTime(event: k8s.CoreV1Event): number {
  const stamp = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp;
  return stamp ? new Date(stamp).getTime() : 0;
}

function normalizeEvent(event: k8s.CoreV1Event): K8sEvent {
  return {
    type: event.type === "Warning" ? "Warning" : "Normal",
    reason: event.reason ?? "",
    message: event.message ?? "",
    count: event.count ?? 1,
    firstTimestamp: event.firstTimestamp
      ? new Date(event.firstTimestamp).toISOString()
      : null,
    lastTimestamp: event.lastTimestamp
      ? new Date(event.lastTimestamp).toISOString()
      : null,
    involvedObject: {
      kind: event.involvedObject.kind ?? "",
      name: event.involvedObject.name ?? "",
      namespace: event.involvedObject.namespace ?? "",
    },
    reportingComponent:
      event.reportingComponent ?? event.source?.component ?? null,
  };
}

function conditionStatus(status: string): "True" | "False" | "Unknown" {
  return status === "True" || status === "False" ? status : "Unknown";
}

function resourceTriple(resources: Record<string, string> | undefined): {
  cpu: string;
  memory: string;
  pods: string;
} {
  return {
    cpu: resources?.["cpu"] ?? "",
    memory: resources?.["memory"] ?? "",
    pods: resources?.["pods"] ?? "",
  };
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// A non-zero exit is a normal result carried in details.causes, not a failure;
// only a real protocol error rejects.
async function execInPod(
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
): Promise<ExecResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
  stderr.on("data", (d: Buffer) => stderrChunks.push(d));

  const exitCode = await new Promise<number>((resolve, reject) => {
    getExec()
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        stderr,
        null,
        false,
        (status) => {
          let code = 0;
          if (status.status === "Success") {
            code = 0;
          } else if (status.reason === "NonZeroExitCode") {
            const cause = status.details?.causes?.find(
              (c) => c.reason === "ExitCode",
            );
            const parsed = cause?.message ? parseInt(cause.message, 10) : NaN;
            code = Number.isNaN(parsed) ? 1 : parsed;
          } else {
            stdout.end();
            stderr.end();
            reject(new Error(status.message ?? "exec failed"));
            return;
          }
          stdout.end();
          stderr.end();
          resolve(code);
        },
      )
      .catch(reject);
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

function parseImageTag(image: string): string {
  return image.includes(":") ? (image.split(":")[1] ?? "latest") : "latest";
}

function parsePsLine(line: string): K8sProcess {
  const parts = line.trim().split(/\s+/);
  return {
    pid: parseInt(parts[0] ?? "0", 10),
    ppid: parseInt(parts[1] ?? "0", 10),
    user: parts[2] ?? "unknown",
    cpuPercent: parseFloat(parts[3] ?? "0"),
    memPercent: parseFloat(parts[4] ?? "0"),
    // A command line carries its own arguments, which is where `-pSECRET` lives.
    command: sanitize(parts.slice(5).join(" ")),
  };
}
