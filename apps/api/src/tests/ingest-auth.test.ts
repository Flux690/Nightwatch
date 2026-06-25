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
import { generateToken } from "../db/tokens.js";
import { generateIngestToken } from "../db/user.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
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

  beforeAll(async () => {
    cleanupDb = useTempDb();
    VALID_TOKEN = generateToken("test-ingest-runner").plaintext;

    // Resolution now matches the alert's labels against the fleet (ADR-0004),
    // so a runner advertising the matching service must be connected for the
    // 200-path tests below to mean anything.
    registerRunner(
      "auth-test-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "auth-test-runner-token",
      manifest("auth-test-runner", "host-auth-test", [WEB_01_SERVICE]),
    );

    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner("auth-test-runner-token");
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
    unregisterRunner("runner-a-token");
    unregisterRunner("runner-b-token");
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
    registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "runner-a-token",
      manifest("runner-a", "host-a", [WEB_01_SERVICE]),
    );

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

  // Replaces 014's single-runner fallback: a multi-runner fleet used to be
  // rejected outright (label-based resolution wasn't built yet). Now the
  // alert's labels are matched against the fleet, so the right runner among
  // several is found deterministically.
  it("resolves correctly among multiple connected runners by matching the advertised service", async () => {
    registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("runner-a", "host-a"));
    registerRunner(
      "runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "runner-b-token",
      manifest("runner-b", "host-b", [WEB_01_SERVICE]),
    );

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

  it("rejects an alert matching no fleet service with HTTP 400, never guessing", async () => {
    registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest("runner-a-token", manifest("runner-a", "host-a"));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-no-match"),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/no runner advertises/i);
  });

  it("rejects an alert matching the same service on two runners with HTTP 400, listing the ambiguous runners", async () => {
    registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "runner-a-token",
      manifest("runner-a", "host-a", [WEB_01_SERVICE]),
    );
    registerRunner(
      "runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "runner-b-token",
      manifest("runner-b", "host-b", [WEB_01_SERVICE]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-ambiguous"),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/ambiguous/i);
    expect(body.error).toMatch(/host-a/);
    expect(body.error).toMatch(/host-b/);
  });

  it("nwr_ tokens resolve by fleet match too - the token authenticates, labels route", async () => {
    const runnerToken = generateToken("nwr-still-works").plaintext;
    // The nwr_ token is never registered as a WS connection; a separate
    // runner advertises the matching service. Under the old token-implies-
    // runner model this would have nothing to fall back to and would fail -
    // succeeding here proves routing no longer reads the token at all.
    registerRunner(
      "runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "runner-a-token",
      manifest("runner-a", "host-a", [WEB_01_SERVICE]),
    );

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
