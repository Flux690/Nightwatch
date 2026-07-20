import { randomUUID } from "node:crypto";
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
import { generateRunnerToken } from "../db/runner.js";
import {
  deletePrometheusIntegration,
  savePrometheusIntegration,
  deleteLokiIntegration,
  saveLokiIntegration,
} from "../db/integrations.js";
import {
  generateAlertSourceToken,
  getAlertSource,
} from "../db/alert-sources.js";

function lastReceived(): string | null {
  return getAlertSource("alertmanager")?.lastReceivedAt ?? null;
}
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { useTempDb } from "./temp-db.js";
import { dockerService, manifest } from "./manifest-helper.js";

const ALERTMANAGER_BODY = {
  alerts: [
    {
      status: "firing",
      labels: {
        alertname: "HighCPU",
        severity: "warning",
        container: "web-01",
      },
      annotations: { summary: "CPU high" },
      startsAt: new Date().toISOString(),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "abc123",
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

// The anonymous Docker fallback identity every body in this file resolves to
// (no Compose labels, just `container: "web-01"`).
const WEB_01_SERVICE = dockerService("web-01");

describe("POST /alerts/ingest auth", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let VALID_TOKEN: string;
  let connAuth: RunnerConnection;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    VALID_TOKEN = generateAlertSourceToken("alertmanager");

    // Resolution matches the alert's labels against the fleet, so a runner advertising
    // the matching service must be connected for the 200-path tests to mean anything.
    connAuth = registerRunner(
      "auth-test-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "auth-test-runner-token",
      manifest("host-auth-test", [WEB_01_SERVICE]),
    );

    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner(connAuth);
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("rejects unknown token with 401 before any processing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": `nwi_unknown-${randomUUID()}` },
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/token/i);
    // A rejected request proves nothing about the pipe - no delivery stamp.
    expect(lastReceived()).toBeNull();
  });

  it("rejects runner tokens - a runner credential grants runner things, never ingest", async () => {
    const runnerToken = generateRunnerToken("not-an-alert-source").plaintext;
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": runnerToken },
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(lastReceived()).toBeNull();
  });

  it("rejects missing token with 401", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid token and processes the alert", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": VALID_TOKEN },
      payload: ALERTMANAGER_BODY,
    });
    // 200 = processed (enqueued or debounced); not 401
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
    // Authenticated, well-formed delivery stamps the pipe as proven - even if
    // this particular alert dedups against an earlier test's routing.
    expect(lastReceived()).not.toBeNull();
  });

  it("accepts a valid Authorization bearer token and processes the alert", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: ALERTMANAGER_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
  });
});

function alertmanagerBody(fingerprint: string): typeof ALERTMANAGER_BODY {
  return {
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "HighCPU",
          severity: "warning",
          container: "web-01",
        },
        annotations: { summary: "CPU high" },
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

describe("POST /alerts/ingest with nwi_ fleet-wide credential", () => {
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

  it("rejects an unknown nwi_ token with 401", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": `nwi_unknown-${randomUUID()}` },
      payload: alertmanagerBody("nwi-unknown"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects only when neither a runner nor a pull-integration can supply evidence", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-no-evidence"),
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/runner|prometheus|loki/i);
    // The webhook DID deliver: the stamp lands before the evidence gate, so the
    // page shows "receiving" even while investigation is blocked.
    expect(lastReceived()).not.toBeNull();

    // Prometheus alone is a sufficient evidence source - the agentless path.
    savePrometheusIntegration({
      baseUrl: "http://prom.internal:9090",
      authHeaderEncrypted: null,
    });
    const promOnly = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-prometheus-only"),
    });
    expect(promOnly.statusCode).toBe(200);
    expect((JSON.parse(promOnly.body) as { enqueued: number }).enqueued).toBe(
      1,
    );
    deletePrometheusIntegration();

    // Loki alone is likewise sufficient - a logs-first, no-metrics fleet.
    saveLokiIntegration({
      baseUrl: "http://loki.internal:3100",
      orgId: null,
      authHeaderEncrypted: null,
    });
    const lokiOnly = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-loki-only"),
    });
    expect(lokiOnly.statusCode).toBe(200);
    expect((JSON.parse(lokiOnly.body) as { enqueued: number }).enqueued).toBe(
      1,
    );
    deleteLokiIntegration();
  });

  it("resolves to the only connected runner when its manifest advertises the matching service", async () => {
    connA = registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("host-a", [WEB_01_SERVICE]));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-single-runner"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
  });

  // The alert's labels are matched against the fleet, so the right runner among
  // several is found deterministically.
  it("resolves correctly among multiple connected runners by matching the advertised service", async () => {
    connA = registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("host-a"));
    connB = registerRunner(
      "runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-b-token", manifest("host-b", [WEB_01_SERVICE]));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-multi-runner"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number; enqueued: number };
    expect(body.received).toBe(1);
    expect(body.enqueued).toBe(1);
  });

  it("enqueues an alert whose identity no runner advertises - the agent triages it from the fleet map", async () => {
    connA = registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("host-a"));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-no-match"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      received: number;
      enqueued: number;
    };
    expect(body.received).toBe(1);
    expect(body.enqueued).toBe(1);
  });

  it("enqueues an alert whose identity two runners advertise - no ambiguity gate at ingest", async () => {
    connA = registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("host-a", [WEB_01_SERVICE]));
    connB = registerRunner(
      "runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-b-token", manifest("host-b", [WEB_01_SERVICE]));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-ambiguous"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      received: number;
      enqueued: number;
    };
    expect(body.received).toBe(1);
    expect(body.enqueued).toBe(1);
  });

  it("returns 400 for an unrecognized payload body so a misconfigured sender learns its body was not understood", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: { notAlerts: true },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/unrecognized payload/i);
  });
});
