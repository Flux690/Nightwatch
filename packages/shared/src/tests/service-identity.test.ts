import { describe, expect, it } from "vitest";
import {
  composeServiceLabels,
  deriveDockerServiceIdentity,
  dockerServiceKey,
  kubernetesWorkloadKey,
} from "../service-identity.js";

describe("target keys", () => {
  it("produces docker/<project>/<service>", () => {
    expect(dockerServiceKey({ project: "myapp", service: "postgres" })).toBe(
      "docker/myapp/postgres",
    );
  });

  it("produces kubernetes/<namespace>/<workload>", () => {
    expect(
      kubernetesWorkloadKey({
        namespace: "production",
        workload: "api-server",
      }),
    ).toBe("kubernetes/production/api-server");
  });

  it("the container sub-selector is excluded, so calls differing only by container address one workload", () => {
    const base = { namespace: "shop", workload: "api" };
    expect(kubernetesWorkloadKey({ ...base, container: "sidecar" })).toBe(
      kubernetesWorkloadKey(base),
    );
  });
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
