import { PassThrough } from "node:stream";
import type {
  ContainerInfo,
  ContainerProcess,
  GetContainerEventsInput,
  GetContainerInspectInput,
  GetContainerListInput,
  GetContainerLogsInput,
  GetContainerProcessesInput,
  GetContainerStatsInput,
  GetEnvVariableNamesInput,
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
      uptimeSeconds: 0,
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
    ...(input.sinceTimestamp !== undefined && {
      sinceSeconds: Math.floor(
        (Date.now() - new Date(input.sinceTimestamp).getTime()) / 1000,
      ),
    }),
    ...(input.stderrOnly === true && { timestamps: false }),
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

  const names = (pod.spec?.containers ?? []).flatMap(
    (c) => (c.env ?? []).map((e) => e.name).filter(Boolean) as string[],
  );

  return { names };
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
