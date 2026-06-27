import { PassThrough } from "node:stream";
import { ApiException, setHeaderOptions } from "@kubernetes/client-node";
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
  requireK8sIdentity,
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

// Distinguishes "this workload is not a Deployment, try StatefulSet next"
// from a genuine failure (permissions, network) that must propagate as-is
// (ADR-0002, user story 9) rather than being masked by the next attempt's
// unrelated 404.
function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

export async function getContainerList(
  input: GetContainerListInput,
): Promise<{ containers: ContainerInfo[] }> {
  const namespace = input.namespace ?? "default";
  const coreApi = getCoreV1Api();
  const podList = await coreApi.listNamespacedPod({ namespace });

  const containers: ContainerInfo[] = podList.items.map((pod) => {
    const name = pod.metadata?.name ?? "";
    const podNamespace = pod.metadata?.namespace ?? namespace;
    // Prefer standard workload-identity labels; fall back to pod name.
    const workload =
      pod.metadata?.labels?.["app.kubernetes.io/name"] ??
      pod.metadata?.labels?.["app"] ??
      name;

    return {
      name,
      id: (pod.metadata?.uid ?? "").slice(0, 12),
      service: {
        provider: "kubernetes" as const,
        namespace: podNamespace,
        workload,
      },
      image: pod.spec?.containers?.[0]?.image ?? "",
      imageTag: parseImageTag(pod.spec?.containers?.[0]?.image ?? ""),
      status: pod.status?.phase ?? "Unknown",
      restartCount: sumRestartCounts(pod),
      uptimeSeconds: pod.status?.startTime
        ? Math.floor(
            (Date.now() - new Date(pod.status.startTime).getTime()) / 1000,
          )
        : 0,
      healthStatus: pod.status?.phase === "Running" ? "healthy" : "unknown",
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
  );
  if (!resolved) return notRunningResult(input.service);

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
  );
  if (!resolved) return notRunningResult(input.service);

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
  );
  if (!resolved || !resolved.live) return notRunningResult(input.service);

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
  );
  if (!resolved) return notRunningResult(input.service);

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
  );
  if (!resolved || !resolved.live) return notRunningResult(input.service);

  const stdout = await execInPod(
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
  );
  if (!resolved) return notRunningResult(input.service);

  const pod = await coreApi.readNamespacedPod({
    name: resolved.podName,
    namespace: resolved.namespace,
  });

  const names = (pod.spec?.containers ?? []).flatMap((c) =>
    (c.env ?? []).flatMap((e) => (e.name ? [e.name] : [])),
  );

  return { names };
}

// Rollout restart (kubectl rollout restart equivalent): patches the
// restartedAt annotation on the pod template so the controller rolls new
// pods, instead of deleting pods directly and bypassing rollout machinery.
export async function restartService(
  input: RestartContainerInput,
): Promise<RestartServiceK8sResult | NoRunningInstanceResult> {
  const service = requireK8sIdentity(input.service);
  const coreApi = getCoreV1Api();
  const appsApi = getAppsV1Api();

  // Restart is a write action on a live target (CONTEXT.md); a stopped
  // instance is "nothing to act on", not a target to restart.
  const resolved = await resolveWorkload(
    coreApi,
    appsApi,
    service.namespace,
    service.workload,
  );
  if (!resolved || !resolved.live) return notRunningResult(input.service);

  const startedAt = new Date().toISOString();
  const patchBody = {
    spec: {
      template: {
        metadata: {
          annotations: {
            "kubectl.kubernetes.io/restartedAt": startedAt,
          },
        },
      },
    },
  };

  try {
    await appsApi.patchNamespacedDeployment(
      {
        name: service.workload,
        namespace: service.namespace,
        body: patchBody,
      },
      STRATEGIC_MERGE_PATCH_OPTIONS,
    );
    return { success: true, startedAt, resourceKind: "Deployment" };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Not a Deployment; try StatefulSet.
  }

  await appsApi.patchNamespacedStatefulSet(
    {
      name: service.workload,
      namespace: service.namespace,
      body: patchBody,
    },
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

  // Exec is a write action on a live target (CONTEXT.md); a stopped instance
  // is "nothing to act on", not a degraded-but-usable target like logs/inspect.
  const resolved = await resolveWorkload(
    coreApi,
    appsApi,
    service.namespace,
    service.workload,
  );
  if (!resolved || !resolved.live) return notRunningResult(input.service);

  const [cmd, ...args] = input.command;
  if (!cmd) throw new Error("command array must not be empty");

  const executedAt = new Date().toISOString();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
  stderr.on("data", (d: Buffer) => stderrChunks.push(d));

  let exitCode = 0;
  await new Promise<void>((resolve, reject) => {
    getExec()
      .exec(
        resolved.namespace,
        resolved.podName,
        resolved.containerName ?? "",
        [cmd, ...args],
        stdout,
        stderr,
        null,
        false,
        (status) => {
          if (status.status === "Success") {
            exitCode = 0;
          } else if (status.reason === "NonZeroExitCode") {
            // Non-zero exit is a normal result, not a protocol failure; the
            // exit code travels in details.causes (ADR-0002: surface raw
            // outcome rather than treating it as an error).
            const cause = status.details?.causes?.find(
              (c) => c.reason === "ExitCode",
            );
            const parsed = cause?.message ? parseInt(cause.message, 10) : NaN;
            exitCode = Number.isNaN(parsed) ? 1 : parsed;
          } else {
            stdout.end();
            stderr.end();
            reject(new Error(status.message ?? "exec failed"));
            return;
          }
          stdout.end();
          stderr.end();
          resolve();
        },
      )
      .catch(reject);
  });

  return {
    exitCode,
    stdout: sanitizeExecOutput(Buffer.concat(stdoutChunks).toString("utf8")),
    stderr: sanitizeExecOutput(Buffer.concat(stderrChunks).toString("utf8")),
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

// Kubernetes-only node-level read (user story 7): when a pod is unhealthy the
// cause may be the node, not the pod. Returns each node's conditions natively -
// Ready plus MemoryPressure/DiskPressure/PIDPressure - alongside allocatable vs
// capacity, with no normalization (ADR-0002). No service identity: pressure is
// a node fact, not a per-workload one.
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

async function execInPod(
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
): Promise<string> {
  const chunks: Buffer[] = [];
  const stdout = new PassThrough();
  stdout.on("data", (d: Buffer) => chunks.push(d));

  return new Promise<string>((resolve, reject) => {
    getExec()
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        null,
        null,
        false,
        (status) => {
          if (status.status === "Failure") {
            reject(new Error(status.message ?? "exec failed"));
          } else {
            stdout.end();
            resolve(Buffer.concat(chunks).toString("utf8"));
          }
        },
      )
      .catch(reject);
  });
}

function parseImageTag(image: string): string {
  return image.includes(":") ? (image.split(":")[1] ?? "latest") : "latest";
}

function sumRestartCounts(pod: {
  status?: { containerStatuses?: Array<{ restartCount?: number }> };
}): number {
  return (pod.status?.containerStatuses ?? []).reduce(
    (sum, cs) => sum + (cs.restartCount ?? 0),
    0,
  );
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
