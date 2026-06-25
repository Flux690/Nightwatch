import { describe, expect, it } from "vitest";
import { parseAlertmanager } from "../alerts/parsers/alertmanager.js";

function webhookWith(labels: Record<string, string>): unknown {
  return {
    alerts: [
      {
        labels,
        annotations: {},
        startsAt: "2026-06-21T10:00:00Z",
        fingerprint: "fp-1",
      },
    ],
  };
}

describe("parseAlertmanager", () => {
  it("prefers Compose project/service labels for the durable identity", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "ContainerDown",
        name: "myapp_postgres_1",
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "myapp",
      service: "postgres",
    });
  });

  it("falls back to the live name when Compose labels are absent (anonymous docker run)", () => {
    const [alert] = parseAlertmanager(
      webhookWith({ alertname: "ContainerDown", name: "redis-cache" }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "redis-cache",
      service: "redis-cache",
    });
  });

  it("builds a Kubernetes identity from namespace + workload labels (ADR-0004)", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "CrashLoopBackOff",
        namespace: "production",
        deployment: "api-server",
        cluster: "cluster-prod",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "kubernetes",
      namespace: "production",
      workload: "api-server",
      cluster: "cluster-prod",
    });
  });

  it("accepts bundled-monitoring labels (compose_project/compose_service) from Prometheus relabeling", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "ContainerHighMemory",
        name: "myapp_api_1",
        compose_project: "myapp",
        compose_service: "api",
        instance: "prod-host-1",
        severity: "warning",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "myapp",
      service: "api",
      server: "prod-host-1",
    });
  });

  it("stamps server scope from instance label when canonical Compose labels are present", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "ContainerDown",
        name: "myapp_postgres_1",
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "postgres",
        instance: "prod-host-2",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "myapp",
      service: "postgres",
      server: "prod-host-2",
    });
  });

  it("stamps server scope from instance label even when falling back to live name", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "ContainerDown",
        name: "redis-cache",
        instance: "prod-host-3",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "redis-cache",
      service: "redis-cache",
      server: "prod-host-3",
    });
  });

  it("produces identity without server when instance label is absent (host-level alert)", () => {
    const [alert] = parseAlertmanager(
      webhookWith({
        alertname: "HostDiskCritical",
        severity: "critical",
      }),
    );

    expect(alert?.targetIdentifier).toEqual({
      provider: "docker",
      project: "unknown",
      service: "unknown",
    });
  });
});
