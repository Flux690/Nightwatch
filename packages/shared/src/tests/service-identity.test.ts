import { describe, expect, it } from "vitest";
import { serviceIdentityKey } from "../service-identity.js";

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
