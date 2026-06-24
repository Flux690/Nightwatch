import * as k8s from "@kubernetes/client-node";

function makeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env["KUBERNETES_SERVICE_HOST"]) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

export function getCoreV1Api(): k8s.CoreV1Api {
  return makeConfig().makeApiClient(k8s.CoreV1Api);
}

export function getAppsV1Api(): k8s.AppsV1Api {
  return makeConfig().makeApiClient(k8s.AppsV1Api);
}

export function getMetrics(): k8s.Metrics {
  return new k8s.Metrics(makeConfig());
}

export function getExec(): k8s.Exec {
  return new k8s.Exec(makeConfig());
}

export function getClusterName(): string | undefined {
  const kc = makeConfig();
  const ctx = kc.getCurrentContext();
  return ctx || undefined;
}
