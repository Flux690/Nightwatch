import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { registerAlertRoutes } from "../alerts/ingest.js";

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
  let userId: string;
  const VALID_TOKEN = `test-ingest-${randomUUID()}`;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `test-ingest-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.token.create({
      data: { token: VALID_TOKEN, userId, hostname: "test-ingest-runner" },
    });

    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.token.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
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
});
