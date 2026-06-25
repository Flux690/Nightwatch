import { describe, expect, it } from "vitest";
import {
  deriveServiceIdentity,
  serviceIdentityKey,
} from "../service-identity.js";

describe("serviceIdentityKey", () => {
  describe("Docker identity", () => {
    it("produces docker/<project>/<service> when no server is present", () => {
      const key = serviceIdentityKey({
        provider: "docker",
        project: "myapp",
        service: "api",
      });
      expect(key).toBe("docker/myapp/api");
    });

    it("produces docker/<server>/<project>/<service> when server is present", () => {
      const key = serviceIdentityKey({
        provider: "docker",
        project: "myapp",
        service: "api",
        server: "server-a",
      });
      expect(key).toBe("docker/server-a/myapp/api");
    });

    it("scoped and unscoped keys never collide", () => {
      const unscoped = serviceIdentityKey({
        provider: "docker",
        project: "myapp",
        service: "api",
      });
      const scoped = serviceIdentityKey({
        provider: "docker",
        project: "myapp",
        service: "api",
        server: "server-a",
      });
      expect(scoped).not.toBe(unscoped);
    });
  });

  describe("Kubernetes identity", () => {
    it("produces kubernetes/<namespace>/<workload> when no cluster is present", () => {
      const key = serviceIdentityKey({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
      });
      expect(key).toBe("kubernetes/production/api-server");
    });

    it("produces kubernetes/<cluster>/<namespace>/<workload> when cluster is present", () => {
      const key = serviceIdentityKey({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
        cluster: "cluster-prod",
      });
      expect(key).toBe("kubernetes/cluster-prod/production/api-server");
    });

    it("scoped and unscoped keys never collide", () => {
      const unscoped = serviceIdentityKey({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
      });
      const scoped = serviceIdentityKey({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
        cluster: "cluster-prod",
      });
      expect(scoped).not.toBe(unscoped);
    });
  });
});

describe("deriveServiceIdentity", () => {
  describe("Docker alert labels", () => {
    it("prefers Compose project/service labels for the candidate identity", () => {
      const identity = deriveServiceIdentity({
        alertname: "ContainerDown",
        name: "myapp_postgres_1",
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
      });
      expect(identity).toEqual({
        provider: "docker",
        project: "myapp",
        service: "postgres",
      });
    });

    it("falls back to the name label when Compose labels are absent", () => {
      const identity = deriveServiceIdentity({
        alertname: "ContainerDown",
        name: "redis-cache",
      });
      expect(identity).toEqual({
        provider: "docker",
        project: "redis-cache",
        service: "redis-cache",
      });
    });

    it("takes the server dimension from the instance label", () => {
      const identity = deriveServiceIdentity({
        alertname: "ContainerDown",
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
        instance: "server-a",
      });
      expect(identity).toEqual({
        provider: "docker",
        project: "myapp",
        service: "postgres",
        server: "server-a",
      });
    });

    it("falls back to the hostname label for the server dimension when instance is absent", () => {
      const identity = deriveServiceIdentity({
        alertname: "ContainerDown",
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
        hostname: "server-b",
      });
      expect(identity).toEqual({
        provider: "docker",
        project: "myapp",
        service: "postgres",
        server: "server-b",
      });
    });
  });

  describe("Kubernetes alert labels", () => {
    it("builds the identity from namespace + deployment labels", () => {
      const identity = deriveServiceIdentity({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        deployment: "api-server",
      });
      expect(identity).toEqual({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
      });
    });

    it("builds the identity from namespace + statefulset labels", () => {
      const identity = deriveServiceIdentity({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        statefulset: "postgres",
      });
      expect(identity).toEqual({
        provider: "kubernetes",
        namespace: "production",
        workload: "postgres",
      });
    });

    it("takes the cluster dimension from the cluster label", () => {
      const identity = deriveServiceIdentity({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        deployment: "api-server",
        cluster: "cluster-prod",
      });
      expect(identity).toEqual({
        provider: "kubernetes",
        namespace: "production",
        workload: "api-server",
        cluster: "cluster-prod",
      });
    });

    it("strips the replica suffix from a pod-only label to recover the workload", () => {
      const identity = deriveServiceIdentity({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        pod: "myapp-7f8b9c-x4k2",
      });
      expect(identity).toEqual({
        provider: "kubernetes",
        namespace: "production",
        workload: "myapp",
      });
    });

    it("strips a single ordinal suffix from a StatefulSet-style pod-only label", () => {
      const identity = deriveServiceIdentity({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        pod: "myapp-0",
      });
      expect(identity).toEqual({
        provider: "kubernetes",
        namespace: "production",
        workload: "myapp",
      });
    });
  });
});
