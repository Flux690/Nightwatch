import "dotenv/config";
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
import { generateIngestToken } from "../db/user.js";
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
    VALID_TOKEN = generateRunnerToken("test-ingest-runner").plaintext;

    // Resolution now matches the alert's labels against the fleet,
    // so a runner advertising the matching service must be connected for the
    // 200-path tests below to mean anything.
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
      headers: { "x-nightwatch-token": `nwr_unknown-${randomUUID()}` },
      payload: ALERTMANAGER_BODY,
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/token/i);
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

  it("rejects with no runner connected", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-no-runner"),
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/runner/i);
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

  // A multi-runner fleet used to be rejected outright (no label resolution yet); now the
  // alert's labels are matched against the fleet, so the right runner among several is found
  // deterministically.
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

  it("reports an unmatched alert in the rejected array, returning 200 so neighbouring alerts are not suppressed", async () => {
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
      rejected: Array<{ sourceAlertId: string; reason: string }>;
    };
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.reason).toMatch(/no runner advertises/i);
  });

  it("reports an ambiguous alert in the rejected array without a 400, listing the conflicting runners", async () => {
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
      rejected: Array<{ sourceAlertId: string; reason: string }>;
    };
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.reason).toMatch(/ambiguous/i);
    expect(body.rejected[0]!.reason).toMatch(/host-a/);
    expect(body.rejected[0]!.reason).toMatch(/host-b/);
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

  it("nwr_ tokens resolve by fleet match too - the token authenticates, labels route", async () => {
    const runnerToken = generateRunnerToken("nwr-still-works").plaintext;
    // The nwr_ token is never a WS connection; a separate runner advertises the matching service.
    // Under the old token-implies-runner model this would fail; succeeding proves routing no
    // longer reads the token at all.
    connA = registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("host-a", [WEB_01_SERVICE]));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": runnerToken },
      payload: alertmanagerBody("nwi-coexist-nwr"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { enqueued: number };
    expect(body.enqueued).toBe(1);
  });
});
