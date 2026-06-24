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
import type { CapabilityManifest } from "@nightwatch/shared";
import { useTempDb } from "./temp-db.js";

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

describe("POST /alerts/ingest auth", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let VALID_TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    VALID_TOKEN = generateToken("test-ingest-runner").plaintext;

    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
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

function manifest(runnerId: string, hostname: string): CapabilityManifest {
  return {
    runnerId,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: [],
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: false,
      remediationEnabled: false,
    },
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

  it("accepts and stamps the only connected runner's id", async () => {
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
      payload: alertmanagerBody("nwi-single-runner"),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { received: number };
    expect(body.received).toBe(1);
  });

  it("rejects with multiple runners connected, never guessing", async () => {
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
    setRunnerManifest("runner-b-token", manifest("runner-b", "host-b"));

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": INGEST_TOKEN },
      payload: alertmanagerBody("nwi-multi-runner"),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/multi-runner/i);
  });

  it("still accepts nwr_ tokens unchanged when an ingest credential is configured", async () => {
    const runnerToken = generateToken("nwr-still-works").plaintext;
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": runnerToken },
      payload: alertmanagerBody("nwi-coexist-nwr"),
    });
    expect(res.statusCode).toBe(200);
  });
});
