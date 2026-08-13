import { describe, expect, it } from "vitest";
import {
  dockerServiceKey,
  type DockerServiceEntry,
  type FleetRunner,
  type K8sWorkloadKind,
  type KubernetesWorkloadEntry,
} from "@nightwarden/shared";
import { resolveAlertTarget } from "../alerts/resolve-target.js";
import { kubernetesWorkload } from "./manifest-helper.js";

function base(name: string) {
  return {
    runnerId: `r-${name}`,
    serverName: name,
    hostname: `${name}-host`,
    online: true,
    lastSeen: Date.now(),
  };
}

function runner(name: string, services: DockerServiceEntry[]): FleetRunner {
  return { ...base(name), platform: "docker", services };
}

function k8sRunner(
  name: string,
  services: KubernetesWorkloadEntry[],
): FleetRunner {
  return { ...base(name), platform: "kubernetes", services };
}

function docker(project: string, service: string): DockerServiceEntry {
  const identity = { project, service };
  return {
    identity,
    target: dockerServiceKey(identity),
    status: "running",
  };
}

function k8s(
  namespace: string,
  workload: string,
  kind: K8sWorkloadKind,
): KubernetesWorkloadEntry {
  return kubernetesWorkload(namespace, workload, kind);
}

describe("resolveAlertTarget", () => {
  describe("Docker", () => {
    const FLEET = [
      runner("prod-1", [docker("encodr", "cache"), docker("encodr", "api")]),
      runner("prod-2", [docker("encodr", "cache")]),
    ];

    it("resolves an alert carrying only Compose labels, with nothing a user configured", () => {
      const res = resolveAlertTarget(
        {
          alertname: "ContainerHighMemory",
          "com.docker.compose.project": "encodr",
          "com.docker.compose.service": "api",
        },
        FLEET,
      );

      expect(res).toEqual({
        kind: "resolved",
        key: "docker/encodr/api",
        identity: { project: "encodr", service: "api" },
      });
    });

    it("reads cAdvisor's rendering of the same Compose labels", () => {
      const res = resolveAlertTarget(
        {
          job: "cadvisor",
          container_label_com_docker_compose_project: "encodr",
          container_label_com_docker_compose_service: "api",
        },
        FLEET,
      );

      expect(res).toMatchObject({
        kind: "resolved",
        key: "docker/encodr/api",
      });
    });

    it("names both runners when the same service runs on each, rather than picking one", () => {
      const res = resolveAlertTarget(
        {
          "com.docker.compose.project": "encodr",
          "com.docker.compose.service": "cache",
        },
        FLEET,
      );

      expect(res).toMatchObject({
        kind: "ambiguous",
        key: "docker/encodr/cache",
      });
      expect((res as { runners: string[] }).runners.sort()).toEqual([
        "prod-1",
        "prod-2",
      ]);
    });

    it("matches an anonymous container by its live name", () => {
      const fleet = [runner("prod-1", [docker("redis-cache", "redis-cache")])];

      expect(resolveAlertTarget({ name: "redis-cache" }, fleet)).toMatchObject({
        kind: "resolved",
        key: "docker/redis-cache/redis-cache",
      });
    });

    it("does not fall back to the live name when Compose labels are present but do not match", () => {
      // cAdvisor commonly sends both forms at once. The Compose pair is the
      // durable one, so a mismatch there is an answer, not a reason to try again.
      const res = resolveAlertTarget(
        {
          name: "encodr_api_1",
          "com.docker.compose.project": "encodr",
          "com.docker.compose.service": "ghost",
        },
        FLEET,
      );

      expect(res).toEqual({ kind: "unresolved" });
    });

    it("is unresolved when nothing advertised matches", () => {
      expect(
        resolveAlertTarget(
          {
            "com.docker.compose.project": "encodr",
            "com.docker.compose.service": "ghost",
          },
          FLEET,
        ),
      ).toEqual({ kind: "unresolved" });
    });

    it("is unresolved when the labels name no service at all", () => {
      expect(
        resolveAlertTarget(
          { alertname: "SomethingBroke", instance: "10.0.0.4:8080" },
          FLEET,
        ),
      ).toEqual({ kind: "unresolved" });
    });
  });

  describe("Kubernetes", () => {
    const FLEET = [
      k8sRunner("cluster-1", [
        k8s("shop", "api", "Deployment"),
        k8s("shop", "db", "StatefulSet"),
        k8s("kube-system", "node-exporter", "DaemonSet"),
      ]),
    ];

    it("resolves a workload named outright by its controller label", () => {
      expect(
        resolveAlertTarget({ namespace: "shop", deployment: "api" }, FLEET),
      ).toMatchObject({ kind: "resolved", key: "kubernetes/shop/api" });
    });

    it("resolves KubePodCrashLooping, which carries only namespace, pod and container", () => {
      const res = resolveAlertTarget(
        {
          alertname: "KubePodCrashLooping",
          namespace: "shop",
          pod: "api-7d9f4c8b6-x2k4m",
          container: "api",
        },
        FLEET,
      );

      expect(res).toMatchObject({
        kind: "resolved",
        key: "kubernetes/shop/api",
      });
    });

    it("resolves a StatefulSet pod by its ordinal suffix", () => {
      expect(
        resolveAlertTarget({ namespace: "shop", pod: "db-0" }, FLEET),
      ).toMatchObject({ kind: "resolved", key: "kubernetes/shop/db" });
    });

    it("resolves a DaemonSet pod, whose name has no template hash", () => {
      expect(
        resolveAlertTarget(
          { namespace: "kube-system", pod: "node-exporter-x9k2m" },
          FLEET,
        ),
      ).toMatchObject({
        kind: "resolved",
        key: "kubernetes/kube-system/node-exporter",
      });
    });

    it("resolves KubeDaemonSetRolloutStuck by its daemonset label", () => {
      expect(
        resolveAlertTarget(
          {
            alertname: "KubeDaemonSetRolloutStuck",
            namespace: "kube-system",
            daemonset: "node-exporter",
          },
          FLEET,
        ),
      ).toMatchObject({ kind: "resolved" });
    });

    it("will not match a workload in another namespace", () => {
      expect(
        resolveAlertTarget({ namespace: "other", deployment: "api" }, FLEET),
      ).toEqual({ kind: "unresolved" });
    });

    it("will not match a statefulset label against a same-named Deployment", () => {
      // The label that named the workload also names its kind.
      expect(
        resolveAlertTarget({ namespace: "shop", statefulset: "api" }, FLEET),
      ).toEqual({ kind: "unresolved" });
    });

    it("will not resolve a pod against a workload whose kind gives it the wrong shape", () => {
      // `db-0` is a StatefulSet shape; a Deployment named `db` is not its owner.
      const fleet = [k8sRunner("c", [k8s("shop", "db", "Deployment")])];

      expect(
        resolveAlertTarget({ namespace: "shop", pod: "db-0" }, fleet),
      ).toEqual({ kind: "unresolved" });
    });

    describe("no wrong confident answer", () => {
      it("resolves a CronJob's pod to neither, though its name fits a Deployment structurally", () => {
        // A CronJob's pod is backup-<unix-minutes>-<5 random>: eight digits then five
        // characters, which is structurally the Deployment shape. It is rejected because
        // a unix-minute timestamp begins with `2`, not a template-hash character.
        const fleet = [k8sRunner("c", [k8s("batch", "backup", "Deployment")])];

        expect(
          resolveAlertTarget(
            { namespace: "batch", pod: "backup-29383920-x9k2m" },
            fleet,
          ),
        ).toEqual({ kind: "unresolved" });
      });

      it("accepts a real template hash, which uses only the ten characters Kubernetes emits", () => {
        const fleet = [k8sRunner("c", [k8s("batch", "backup", "Deployment")])];

        expect(
          resolveAlertTarget(
            { namespace: "batch", pod: "backup-5f7d9bc4c-x9k2m" },
            fleet,
          ),
        ).toMatchObject({ kind: "resolved" });
      });

      it("refuses to choose when two advertised workloads both claim the pod name", () => {
        const fleet = [
          k8sRunner("c", [
            k8s("shop", "api", "Deployment"),
            k8s("shop", "api-7d9f4c8b6", "DaemonSet"),
          ]),
        ];

        expect(
          resolveAlertTarget(
            { namespace: "shop", pod: "api-7d9f4c8b6-x2k4m" },
            fleet,
          ),
        ).toEqual({ kind: "unresolved" });
      });

      it("rejects a suffix that is not exactly five pod-alphabet characters", () => {
        const fleet = [k8sRunner("c", [k8s("shop", "api", "Deployment")])];

        for (const pod of [
          "api-5f7d9bc4c-x2k4", // four
          "api-5f7d9bc4c-x2k4mm", // six
          "api-5f7d9bc4c-x2k4a", // 'a' is not in the pod-suffix alphabet
        ]) {
          expect(resolveAlertTarget({ namespace: "shop", pod }, fleet)).toEqual(
            { kind: "unresolved" },
          );
        }
      });
    });
  });

  describe("mixed fleet", () => {
    it("does not let a Docker container of the same name spoil a Kubernetes match", () => {
      // A Kubernetes alert carries `container`, which is also how an anonymous
      // Docker container is named. Matching both would produce two distinct keys
      // and force a perfectly resolvable alert to unresolved.
      const fleet = [
        runner("docker-host", [docker("api", "api")]),
        k8sRunner("cluster-1", [k8s("shop", "api", "Deployment")]),
      ];

      const res = resolveAlertTarget(
        {
          alertname: "KubePodCrashLooping",
          namespace: "shop",
          pod: "api-7d9f4c8b6-x2k4m",
          container: "api",
        },
        fleet,
      );

      expect(res).toMatchObject({
        kind: "resolved",
        key: "kubernetes/shop/api",
      });
    });

    it("still resolves a Docker alert, which carries no namespace", () => {
      const fleet = [
        runner("docker-host", [docker("api", "api")]),
        k8sRunner("cluster-1", [k8s("shop", "api", "Deployment")]),
      ];

      expect(resolveAlertTarget({ container: "api" }, fleet)).toMatchObject({
        kind: "resolved",
        key: "docker/api/api",
      });
    });
  });

  it("is unresolved against an empty fleet, since nothing is advertised to match", () => {
    expect(
      resolveAlertTarget({ namespace: "shop", deployment: "api" }, []),
    ).toEqual({ kind: "unresolved" });
  });

  it("keys a resolved Kubernetes target with three segments, like every other key", () => {
    const fleet = [k8sRunner("c", [k8s("shop", "api", "Deployment")])];
    const res = resolveAlertTarget(
      { namespace: "shop", deployment: "api" },
      fleet,
    );

    expect((res as { key: string }).key.split("/")).toHaveLength(3);
  });
});
