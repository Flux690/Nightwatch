import { PassThrough } from "node:stream";
import { setHeaderOptions } from "@kubernetes/client-node";
import { serviceIdentityKey } from "@nightwarden/shared";
import type {
  K8sNodeStatusResult,
  K8sRestartResult,
  K8sRolloutStatusInput,
  ServiceBashInput,
  ServiceBashResult,
  ServiceConfigInput,
  ServiceEventsInput,
  ServiceInstance,
  ServiceListInput,
  ServiceListResult,
  ServiceLogsInput,
  ServiceLogsResult,
  ServiceProcess,
  ServiceProcessesInput,
  ServiceProcessesResult,
  ServiceRestartInput,
  ServiceStatsInput,
} from "@nightwarden/shared";
import { getCoreV1Api, getAppsV1Api, getMetrics, getExec } from "./client.js";
import {
  resolveWorkload,
  resolveWorkloadKind,
  requireK8sIdentity,
  isNotFoundError,
  notRunningResult,
  type NoRunningInstanceResult,
} from "./resolve-service.js";
import { sanitizeExecOutput } from "../safety/allowlist.js";

// kubectl rollout restart sends this Content-Type so the server merges the annotation into
// spec.template.metadata.annotations instead of interpreting the body as a JSON Patch operation array (the client's default for PATCH).
const STRATEGIC_MERGE_PATCH_OPTIONS = setHeaderOptions(
  "Content-Type",
  "application/strategic-merge-patch+json",
);

// List workloads (Deployments+StatefulSets), not pods, so the identity matches the manifest byte-for-byte;
// a pod-label identity diverged, so a listed service couldn't be resolved back and the breaker mis-keyed it.
export async function getContainerList(
  input: ServiceListInput,
): Promise<ServiceListResult> {
  const namespace = input.namespace ?? "default";
  const appsApi = getAppsV1Api();
  // Env-only, identical to the manifest (detect.ts): the kubeconfig context name
  // is not an authoritative cluster identity.
  const cluster = process.env["NIGHTWARDEN_CLUSTER_NAME"];

  const [deployments, statefulSets] = await Promise.all([
    appsApi.listNamespacedDeployment({ namespace }),
    appsApi.listNamespacedStatefulSet({ namespace }),
  ]);

  const containers: ServiceInstance[] = [
    ...deployments.items,
    ...statefulSets.items,
  ].map((w) => {
    const name = w.metadata?.name ?? "";
    const image = w.spec?.template?.spec?.containers?.[0]?.image ?? "";
    const desired = w.spec?.replicas ?? 0;
    const ready = w.status?.readyReplicas ?? 0;
    return {
      name,
      id: (w.metadata?.uid ?? "").slice(0, 12),
      target: serviceIdentityKey({
        provider: "kubernetes" as const,
        namespace: w.metadata?.namespace ?? namespace,
        workload: name,
        ...(cluster && { cluster }),
      }),
      image,
      imageTag: parseImageTag(image),
      status: ready > 0 ? "Running" : "Stopped",
      // restartCount/uptime are pod-level; at workload granularity they are not
      // meaningful, so they are reported as 0 rather than guessed.
      restartCount: 0,
      uptimeSeconds: 0,
      healthStatus: desired > 0 && ready >= desired ? "healthy" : "unknown",
    };
  });

  return { containers };
}

export async function getContainerLogs(
  input: ServiceLogsInput,
): Promise<ServiceLogsResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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

  const log = await coreApi.readNamespacedPodLog({
    name: resolved.podName,
    namespace: resolved.namespace,
    container: resolved.containerName,
    tailLines: input.tailLines ?? 200,
    // When the resolved pod is not live we fell back to a terminated instance (a crash-loop's dead container);
    // its useful output lives in the previous container, so request that rather than the empty current one.
    previous: !resolved.live,
    // K8s merges stdout and stderr; stderrOnly is not supported by the API.
    ...(input.sinceTimestamp !== undefined && {
      sinceSeconds: Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(input.sinceTimestamp).getTime()) / 1000,
        ),
      ),
    }),
  });

  const lines = log.split("\n").filter(Boolean);
  // Kubernetes reads are already tail-scoped server-side, so nothing is
  // filtered here; the count fields keep the shared logs shape honest.
  return {
    lines,
    totalLines: lines.length,
    droppedLines: 0,
    compressionNote: "",
  };
}

export async function getContainerInspect(
  input: ServiceConfigInput,
): Promise<unknown | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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

  const pod = await coreApi.readNamespacedPod({
    name: resolved.podName,
    namespace: resolved.namespace,
  });

  // Shaped, never the raw pod: a pod spec inlines literal env values, which are secrets and must never
  // reach the model - env var names only, the same contract the docker handler keeps.
  return {
    podName: pod.metadata?.name ?? resolved.podName,
    namespace: resolved.namespace,
    nodeName: pod.spec?.nodeName ?? null,
    phase: pod.status?.phase ?? "Unknown",
    restartPolicy: pod.spec?.restartPolicy ?? "Always",
    createdAt: pod.metadata?.creationTimestamp ?? null,
    containers: (pod.spec?.containers ?? []).map((c) => ({
      name: c.name,
      image: c.image ?? "",
      envVarNames: (c.env ?? []).flatMap((e) => (e.name ? [e.name] : [])),
      ports: (c.ports ?? []).map(
        (p) => `${p.containerPort}/${p.protocol ?? "TCP"}`,
      ),
      volumeMounts: (c.volumeMounts ?? []).map((m) => ({
        name: m.name,
        mountPath: m.mountPath,
        readOnly: m.readOnly ?? false,
      })),
      resources: c.resources ?? {},
      livenessProbe: c.livenessProbe ?? null,
      readinessProbe: c.readinessProbe ?? null,
    })),
    containerStatuses: (pod.status?.containerStatuses ?? []).map((s) => ({
      name: s.name,
      ready: s.ready,
      restartCount: s.restartCount,
      state: s.state ?? {},
    })),
  };
}

export async function getContainerStats(
  input: ServiceStatsInput,
): Promise<unknown | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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

  // Metrics-server may not be installed; if not, the raw error propagates
  // so the agent reports the real cause.
  const metricsList = await getMetrics().getPodMetrics(service.namespace);
  const podMetric = metricsList.items.find(
    (m) => m.metadata.name === resolved.podName,
  );

  return { podMetric: podMetric ?? null, podName: resolved.podName };
}

export async function getContainerEvents(
  input: ServiceEventsInput,
): Promise<unknown | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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

  // Field selector filters events for this specific pod.
  const events = await coreApi.listNamespacedEvent({
    namespace: service.namespace,
    fieldSelector: `involvedObject.name=${resolved.podName}`,
  });

  return { events: events.items };
}

export async function getContainerProcesses(
  input: ServiceProcessesInput,
): Promise<ServiceProcessesResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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

  const processes: ServiceProcess[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parsePsLine);

  return { processes };
}

// Rolls via a restartedAt annotation, never deleting pods directly; the exact
// kind is resolved first so a same-named Deployment/StatefulSet can't be confused.
export async function restartService(
  input: ServiceRestartInput,
): Promise<K8sRestartResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
  const appsApi = getAppsV1Api();

  const workload = await resolveWorkloadKind(
    appsApi,
    service.namespace,
    service.workload,
  );
  // A missing or scaled-to-0 workload has nothing to roll; a running-but-unhealthy
  // one is still restartable - that's the case you most want to fix.
  if (workload === null || workload.replicas === 0) {
    return notRunningResult(input.service);
  }

  const startedAt = new Date().toISOString();
  const patchBody = {
    spec: {
      template: {
        metadata: {
          annotations: { "kubectl.kubernetes.io/restartedAt": startedAt },
        },
      },
    },
  };

  if (workload.kind === "Deployment") {
    await appsApi.patchNamespacedDeployment(
      { name: service.workload, namespace: service.namespace, body: patchBody },
      STRATEGIC_MERGE_PATCH_OPTIONS,
    );
    return { success: true, startedAt, resourceKind: "Deployment" };
  }

  await appsApi.patchNamespacedStatefulSet(
    { name: service.workload, namespace: service.namespace, body: patchBody },
    STRATEGIC_MERGE_PATCH_OPTIONS,
  );
  return { success: true, startedAt, resourceKind: "StatefulSet" };
}

export async function execCommand(
  input: ServiceBashInput,
): Promise<ServiceBashResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
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
    stdout: sanitizeExecOutput(stdout),
    stderr: sanitizeExecOutput(stderr),
    executedAt,
  };
}

// Kubernetes-only: rollout state has no Docker equivalent, so it's never
// offered to Docker-only fleets.
export async function getRolloutStatus(
  input: K8sRolloutStatusInput,
): Promise<unknown | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
  const appsApi = getAppsV1Api();

  try {
    const deploy = await appsApi.readNamespacedDeployment({
      name: service.workload,
      namespace: service.namespace,
    });
    return {
      kind: "Deployment" as const,
      name: deploy.metadata?.name,
      replicas: deploy.spec?.replicas ?? 0,
      readyReplicas: deploy.status?.readyReplicas ?? 0,
      updatedReplicas: deploy.status?.updatedReplicas ?? 0,
      availableReplicas: deploy.status?.availableReplicas ?? 0,
      conditions: deploy.status?.conditions ?? [],
    };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Not a Deployment; try StatefulSet.
  }

  try {
    const sts = await appsApi.readNamespacedStatefulSet({
      name: service.workload,
      namespace: service.namespace,
    });
    return {
      kind: "StatefulSet" as const,
      name: sts.metadata?.name,
      replicas: sts.spec?.replicas ?? 0,
      readyReplicas: sts.status?.readyReplicas ?? 0,
      updatedReplicas: sts.status?.updatedReplicas ?? 0,
      conditions: sts.status?.conditions ?? [],
    };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    return notRunningResult(input.service);
  }
}

// An unhealthy pod's cause may be the node; no service identity here since
// pressure is a node fact, not a per-workload one.
export async function getNodeStatus(): Promise<K8sNodeStatusResult> {
  const coreApi = getCoreV1Api();
  const nodeList = await coreApi.listNode();

  const nodes = nodeList.items.map((node) => ({
    name: node.metadata?.name ?? "",
    conditions: node.status?.conditions ?? [],
    allocatable: node.status?.allocatable ?? {},
    capacity: node.status?.capacity ?? {},
  }));

  return { nodes };
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

function parsePsLine(line: string): ServiceProcess {
  const parts = line.trim().split(/\s+/);
  return {
    pid: parseInt(parts[0] ?? "0", 10),
    ppid: parseInt(parts[1] ?? "0", 10),
    user: parts[2] ?? "unknown",
    cpuPercent: parseFloat(parts[3] ?? "0"),
    memPercent: parseFloat(parts[4] ?? "0"),
    command: parts.slice(5).join(" "),
  };
}
