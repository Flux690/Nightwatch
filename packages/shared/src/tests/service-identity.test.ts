import { describe, expect, it } from "vitest";
import {
  composeServiceLabels,
  deriveDockerServiceIdentity,
  dockerServiceKey,
  kubernetesWorkloadKey,
  parseTargetKey,
} from "../service-identity.js";

describe("target keys", () => {
  it("produces <server>/<project>/<service>", () => {
    expect(
      dockerServiceKey("web-01", { project: "myapp", service: "postgres" }),
    ).toBe("web-01/myapp/postgres");
  });

  it("produces <server>/<namespace>/<workload>", () => {
    expect(
      kubernetesWorkloadKey("prod-cluster", {
        namespace: "production",
        workload: "api-server",
      }),
    ).toBe("prod-cluster/production/api-server");
  });

  it("the container sub-selector is excluded, so calls differing only by container address one workload", () => {
    const base = { namespace: "shop", workload: "api" };
    expect(kubernetesWorkloadKey("c", { ...base, container: "sidecar" })).toBe(
      kubernetesWorkloadKey("c", base),
    );
  });

  // The same service on two machines is two keys, which is the whole point of
  // the server segment: one key can never mean two containers.
  it("distinguishes the same service on two servers", () => {
    const id = { project: "encodr", service: "cache" };
    expect(dockerServiceKey("prod-1", id)).not.toBe(
      dockerServiceKey("prod-2", id),
    );
  });
});

describe("parseTargetKey", () => {
  it("splits a key into the server, the scope and the name", () => {
    expect(parseTargetKey("web-01/shop/api")).toEqual({
      server: "web-01",
      scope: "shop",
      name: "api",
    });
  });

  it.each(["", "web-01", "web-01/shop", "web-01/shop/api/extra", "//api"])(
    "refuses %o, which is not three non-empty segments",
    (bad) => {
      expect(parseTargetKey(bad)).toBeNull();
    },
  );
});

describe("composeServiceLabels", () => {
  it("reads Docker's own dotted labels", () => {
    expect(
      composeServiceLabels({
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
      }),
    ).toEqual({ project: "myapp", service: "postgres" });
  });

  it("reads the underscored rendering", () => {
    expect(
      composeServiceLabels({
        compose_project: "myapp",
        compose_service: "postgres",
      }),
    ).toEqual({ project: "myapp", service: "postgres" });
  });

  it("reads cAdvisor's container_label_ rendering", () => {
    expect(
      composeServiceLabels({
        job: "cadvisor",
        container_label_com_docker_compose_project: "encodr",
        container_label_com_docker_compose_service: "cache",
      }),
    ).toEqual({ project: "encodr", service: "cache" });
  });

  it("is null unless both halves of the pair are present", () => {
    expect(
      composeServiceLabels({ "com.docker.compose.project": "myapp" }),
    ).toBeNull();
    expect(composeServiceLabels({ name: "redis-cache" })).toBeNull();
    expect(composeServiceLabels(undefined)).toBeNull();
  });
});

describe("deriveDockerServiceIdentity", () => {
  it("prefers the Compose labels, which survive a recreate, over the live name", () => {
    expect(
      deriveDockerServiceIdentity(
        {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
        },
        "myapp_postgres_1",
      ),
    ).toEqual({ project: "myapp", service: "postgres" });
  });

  it("falls back to the live name for an anonymous `docker run` container", () => {
    expect(deriveDockerServiceIdentity({}, "redis-cache")).toEqual({
      project: "redis-cache",
      service: "redis-cache",
    });
  });

  it("ignores foreign labels that merely look like scope", () => {
    // `server` belongs to other exporters (postgres_exporter stamps a db address
    // on it), and no label of any name can widen an identity any more.
    expect(
      deriveDockerServiceIdentity(
        {
          "com.docker.compose.project": "myapp",
          "com.docker.compose.service": "postgres",
          instance: "localhost:8080",
          hostname: "some-host",
          server: "db-host:5432",
        },
        "myapp_postgres_1",
      ),
    ).toEqual({ project: "myapp", service: "postgres" });
  });
});
