import { PassThrough } from "node:stream";
import { setHeaderOptions } from "@kubernetes/client-node";
import type {
  ContainerInfo,
  ContainerProcess,
  ExecCommandInput,
  ExecCommandResult,
  GetContainerEventsInput,
  GetContainerInspectInput,
  GetContainerListInput,
  GetContainerLogsInput,
  GetContainerProcessesInput,
  GetContainerStatsInput,
  GetEnvVariableNamesInput,
  GetK8sRolloutStatusInput,
  RestartContainerInput,
  RestartServiceK8sResult,
} from "@nightwatch/shared";
import {
  getCoreV1Api,
  getAppsV1Api,
  getMetrics,
  getExec,
} from "../kubernetes-client.js";
import {
  resolveWorkload,
  resolveWorkloadKind,
  requireK8sIdentity,
  isNotFoundError,
  notRunningResult,
  type NoRunningInstanceResult,
} from "./resolve-service.js";
import { sanitizeExecOutput } from "../safety/allowlist.js";

// kubectl rollout restart sends this Content-Type so the server merges the
// annotation into spec.template.metadata.annotations instead of interpreting
// the body as a JSON Patch operation array (the client's default for PATCH).
const STRATEGIC_MERGE_PATCH_OPTIONS = setHeaderOptions(
  "Content-Type",
  "application/strategic-merge-patch+json",
);

// List workloads (Deployments+StatefulSets), not pods, so the identity matches the
// manifest byte-for-byte; a pod-label identity diverged, so a listed service couldn't
// be resolved back and the breaker mis-keyed it.
export async function getContainerList(
  input: GetContainerListInput,
): Promise<{ containers: ContainerInfo[] }> {
  const namespace = input.namespace ?? "default";
  const appsApi = getAppsV1Api();
  // Env-only, identical to the manifest (detect.ts): the kubeconfig context name
  // is not an authoritative cluster identity.
  const cluster = process.env["NIGHTWATCH_CLUSTER_NAME"];

  const [deployments, statefulSets] = await Promise.all([
    appsApi.listNamespacedDeployment({ namespace }),
    appsApi.listNamespacedStatefulSet({ namespace }),
  ]);

  const containers: ContainerInfo[] = [
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
      service: {
        provider: "kubernetes" as const,
        namespace: w.metadata?.namespace ?? namespace,
        workload: name,
        ...(cluster && { cluster }),
      },
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
  input: GetContainerLogsInput,
): Promise<{ lines: string[] } | NoRunningInstanceResult> {
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
    // When the resolved pod is not live we fell back to a terminated instance
    // (a crash-loop's dead container); its useful output lives in the previous
    // container, so request that rather than the empty current one (story 14).
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
  return { lines };
}

export async function getContainerInspect(
  input: GetContainerInspectInput,
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

  // Return native K8s pod object - no normalization (ADR-0002).
  return coreApi.readNamespacedPod({
    name: resolved.podName,
    namespace: resolved.namespace,
  });
}

export async function getContainerStats(
  input: GetContainerStatsInput,
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
  // (user story 9, ADR-0002) so the agent reports the real cause.
  const metricsList = await getMetrics().getPodMetrics(service.namespace);
  const podMetric = metricsList.items.find(
    (m) => m.metadata.name === resolved.podName,
  );

  return { podMetric: podMetric ?? null, podName: resolved.podName };
}

export async function getContainerEvents(
  input: GetContainerEventsInput,
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
  input: GetContainerProcessesInput,
): Promise<{ processes: ContainerProcess[] } | NoRunningInstanceResult> {
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

  const processes: ContainerProcess[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parsePsLine);

  return { processes };
}

export async function getEnvVariableNames(
  input: GetEnvVariableNamesInput,
): Promise<{ names: string[] } | NoRunningInstanceResult> {
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

  const names = (pod.spec?.containers ?? []).flatMap((c) =>
    (c.env ?? []).flatMap((e) => (e.name ? [e.name] : [])),
  );

  return { names };
}

// Rollout restart via a restartedAt annotation so the controller rolls new pods (not
// deleting pods directly); the exact kind is resolved first so a Deployment and a
// StatefulSet sharing a name can't be confused.
export async function restartService(
  input: RestartContainerInput,
): Promise<RestartServiceK8sResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
  const appsApi = getAppsV1Api();

  const workload = await resolveWorkloadKind(
    appsApi,
    service.namespace,
    service.workload,
  );
  // Restart is a write on a live target (CONTEXT.md): a missing or scaled-to-0
  // workload has nothing to roll. A running-but-unhealthy one (replicas > 0,
  // none ready) is still restartable - that is the case you most want to fix.
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
  input: ExecCommandInput,
): Promise<ExecCommandResult | NoRunningInstanceResult> {
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

// Provider-specific (Kubernetes-only) read tool proving the providers hook
// (ADR-0002): rollout state has no Docker equivalent, so it is never offered
// to Docker-only fleets.
export async function getRolloutStatus(
  input: GetK8sRolloutStatusInput,
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

// Node-level read: an unhealthy pod's cause may be the node. Returns each node's
// conditions and allocatable vs capacity natively (ADR-0002); no service identity,
// since pressure is a node fact, not a per-workload one.
export async function getNodeStatus(): Promise<{
  nodes: Array<{
    name: string;
    conditions: unknown;
    allocatable: unknown;
    capacity: unknown;
  }>;
}> {
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

// One exec primitive for reads and exec_command: a non-zero exit is a normal result
// carried in details.causes (ADR-0002), not a failure; only a real protocol error
// (no such container, connection error) rejects.
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

function parsePsLine(line: string): ContainerProcess {
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
