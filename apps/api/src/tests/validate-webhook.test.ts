import "dotenv/config";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { generateIngestToken } from "../db/user.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
import { useTempDb } from "./temp-db.js";
import { dockerService, manifest } from "./manifest-helper.js";

function alertmanagerBody(fingerprint: string, labels: Record<string, string>) {
  return {
    alerts: [
      {
        status: "firing",
        labels,
        annotations: { summary: "test" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint,
      },
    ],
    version: "4",
    groupKey: "test",
    receiver: "nightwatch",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("POST /alerts/validate", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let INGEST_TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    INGEST_TOKEN = generateIngestToken();
    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    unregisterRunner("validate-runner-a-token");
    unregisterRunner("validate-runner-b-token");
  });

  it("returns the parsed identity and resolved runner for a well-labelled alert, without dispatching", async () => {
    registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("runner-a", "host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-1", {
        alertname: "HighCPU",
        severity: "warning",
        container: "web-01",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{
        identity: unknown;
        identityKey: string;
        resolution: { status: string; runnerId?: string; hostname?: string };
      }>;
    };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]!.identity).toEqual({
      provider: "docker",
      project: "web-01",
      service: "web-01",
    });
    expect(body.alerts[0]!.identityKey).toBe("docker/web-01/web-01");
    expect(body.alerts[0]!.resolution).toEqual({
      status: "resolved",
      runnerId: "runner-a",
      hostname: "host-a",
    });
  });

  it("resolves a Kubernetes alert by namespace + deployment labels", async () => {
    registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("runner-a", "host-a", [
        {
          identity: {
            provider: "kubernetes",
            namespace: "production",
            workload: "api-server",
          },
          status: "running",
        },
      ]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-k8s", {
        alertname: "CrashLoopBackOff",
        severity: "critical",
        namespace: "production",
        deployment: "api-server",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{
        identity: unknown;
        identityKey: string;
        resolution: { status: string; runnerId?: string; hostname?: string };
      }>;
    };
    expect(body.alerts[0]!.identity).toEqual({
      provider: "kubernetes",
      namespace: "production",
      workload: "api-server",
    });
    expect(body.alerts[0]!.identityKey).toBe(
      "kubernetes/production/api-server",
    );
    expect(body.alerts[0]!.resolution).toEqual({
      status: "resolved",
      runnerId: "runner-a",
      hostname: "host-a",
    });
  });

  it("rejects a poorly-labelled alert with a diagnostic reason, still returning its parsed identity", async () => {
    registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("runner-a", "host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-no-match", {
        alertname: "HighCPU",
        severity: "warning",
        container: "ghost-service",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{
        identityKey: string;
        resolution: { status: string; reason?: string };
      }>;
    };
    expect(body.alerts[0]!.identityKey).toBe(
      "docker/ghost-service/ghost-service",
    );
    expect(body.alerts[0]!.resolution.status).toBe("rejected");
    expect(body.alerts[0]!.resolution.reason).toMatch(/no runner advertises/i);
  });

  it("rejects an alert advertised by two runners as ambiguous, listing both hostnames", async () => {
    const identity = {
      provider: "docker" as const,
      project: "shared",
      service: "shared",
    };
    registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("runner-a", "host-a", [{ identity, status: "running" }]),
    );
    registerRunner(
      "validate-runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-b-token",
      manifest("runner-b", "host-b", [{ identity, status: "running" }]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-ambiguous", {
        alertname: "HighCPU",
        severity: "warning",
        container: "shared",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{ resolution: { status: string; reason?: string } }>;
    };
    expect(body.alerts[0]!.resolution.status).toBe("rejected");
    expect(body.alerts[0]!.resolution.reason).toMatch(/ambiguous/i);
    expect(body.alerts[0]!.resolution.reason).toMatch(/host-a/);
    expect(body.alerts[0]!.resolution.reason).toMatch(/host-b/);
  });

  it("reports each alert in a multi-alert payload independently, so one rejection doesn't mask a sibling's match", async () => {
    registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("runner-a", "host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: {
        alerts: [
          {
            status: "firing",
            labels: { alertname: "HighCPU", container: "web-01" },
            annotations: {},
            startsAt: new Date().toISOString(),
            endsAt: "0001-01-01T00:00:00Z",
            fingerprint: "multi-1",
          },
          {
            status: "firing",
            labels: { alertname: "HighCPU", container: "ghost-service" },
            annotations: {},
            startsAt: new Date().toISOString(),
            endsAt: "0001-01-01T00:00:00Z",
            fingerprint: "multi-2",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{
        sourceAlertId: string;
        resolution: { status: string };
      }>;
    };
    expect(body.alerts).toHaveLength(2);
    expect(
      body.alerts.find((a) => a.sourceAlertId === "multi-1")!.resolution.status,
    ).toBe("resolved");
    expect(
      body.alerts.find((a) => a.sourceAlertId === "multi-2")!.resolution.status,
    ).toBe("rejected");
  });

  it("returns a clear 400 error for a malformed payload missing the alerts array", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: { notAlerts: true },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("rejects requests without a valid token before parsing the payload", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      payload: alertmanagerBody("validate-noauth", { container: "web-01" }),
    });

    expect(res.statusCode).toBe(401);
  });
});
