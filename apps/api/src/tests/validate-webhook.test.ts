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
import { generateAlertSourceToken } from "../db/alert-sources.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
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
    receiver: "nightwarden",
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
  let connA: RunnerConnection | undefined;
  let connB: RunnerConnection | undefined;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    INGEST_TOKEN = generateAlertSourceToken("alertmanager");
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
    if (connA) {
      unregisterRunner(connA);
      connA = undefined;
    }
    if (connB) {
      unregisterRunner(connB);
      connB = undefined;
    }
  });

  it("returns the parsed identity and an exact advisory fleet match for a well-labelled alert, without dispatching", async () => {
    connA = registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-1", {
        alertname: "HighCPU",
        severity: "warning",
        container: "web-01",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{
        identityKey: string;
        advertisedOn: string[];
        exactMatch: boolean;
      }>;
    };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]!.identityKey).toBe("docker/web-01/web-01");
    expect(body.alerts[0]!.advertisedOn).toEqual(["host-a"]);
    expect(body.alerts[0]!.exactMatch).toBe(true);
  });

  it("matches a Kubernetes alert by namespace + deployment labels", async () => {
    connA = registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("host-a", [
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
      headers: { "x-nightwarden-token": INGEST_TOKEN },
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
        identityKey: string;
        advertisedOn: string[];
        exactMatch: boolean;
      }>;
    };
    expect(body.alerts[0]!.identityKey).toBe(
      "kubernetes/production/api-server",
    );
    expect(body.alerts[0]!.advertisedOn).toEqual(["host-a"]);
    expect(body.alerts[0]!.exactMatch).toBe(true);
  });

  it("reports no advisory match for a poorly-labelled alert, still returning its parsed identity", async () => {
    connA = registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
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
        advertisedOn: string[];
        exactMatch: boolean;
      }>;
    };
    expect(body.alerts[0]!.identityKey).toBe(
      "docker/ghost-service/ghost-service",
    );
    expect(body.alerts[0]!.advertisedOn).toEqual([]);
    expect(body.alerts[0]!.exactMatch).toBe(false);
  });

  it("lists every advertising server for an identity owned by two runners, without an exact match", async () => {
    const identity = {
      provider: "docker" as const,
      project: "shared",
      service: "shared",
    };
    connA = registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("host-a", [{ identity, status: "running" }]),
    );
    connB = registerRunner(
      "validate-runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-b-token",
      manifest("host-b", [{ identity, status: "running" }]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
      payload: alertmanagerBody("validate-ambiguous", {
        alertname: "HighCPU",
        severity: "warning",
        container: "shared",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      alerts: Array<{ advertisedOn: string[]; exactMatch: boolean }>;
    };
    expect(body.alerts[0]!.advertisedOn).toContain("host-a");
    expect(body.alerts[0]!.advertisedOn).toContain("host-b");
    expect(body.alerts[0]!.exactMatch).toBe(false);
  });

  it("reports each alert in a multi-alert payload independently, so a non-match doesn't mask a sibling's match", async () => {
    connA = registerRunner(
      "validate-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "validate-runner-a-token",
      manifest("host-a", [dockerService("web-01")]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
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
      alerts: Array<{ sourceAlertId: string; exactMatch: boolean }>;
    };
    expect(body.alerts).toHaveLength(2);
    expect(
      body.alerts.find((a) => a.sourceAlertId === "multi-1")!.exactMatch,
    ).toBe(true);
    expect(
      body.alerts.find((a) => a.sourceAlertId === "multi-2")!.exactMatch,
    ).toBe(false);
  });

  it("returns a clear 400 error for a malformed payload missing the alerts array", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/validate",
      headers: { "x-nightwarden-token": INGEST_TOKEN },
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
