import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { CapabilityManifest } from "@nightwatch/shared";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { registerAlertTestRoutes } from "../alerts/test-alert.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";

function manifest(
  runnerId: string,
  hostname: string,
  services: CapabilityManifest["capabilities"]["services"] = [],
): CapabilityManifest {
  return {
    runnerId,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services,
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: false,
      remediationEnabled: false,
    },
  };
}

describe("POST /alerts/test", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await registerAlertTestRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  afterEach(() => {
    unregisterRunner("verify-runner-token");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      payload: { runnerId: "runner-verify" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when runnerId is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the runner is not connected", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { runnerId: "no-such-runner" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/runner/i);
  });

  it("fires a synthetic alert through the real pipeline for a connected runner", async () => {
    registerRunner(
      "verify-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "verify-runner-token",
      manifest("runner-verify", "host-verify"),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { runnerId: "runner-verify" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      status: "enqueued" | "skipped";
      runnerId: string;
      hostname: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("enqueued");
    expect(body.runnerId).toBe("runner-verify");
    expect(body.hostname).toBe("host-verify");
  });

  it("uses the runner's first advertised service identity when present", async () => {
    registerRunner(
      "verify-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "verify-runner-token",
      manifest("runner-verify", "host-verify", [
        {
          identity: { provider: "docker", project: "myapp", service: "api" },
          status: "running",
        },
      ]),
    );

    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { runnerId: "runner-verify" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for an offline runner, never guessing reachability", async () => {
    registerRunner(
      "verify-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "verify-runner-token",
      manifest("runner-verify", "host-verify"),
    );
    unregisterRunner("verify-runner-token");

    const res = await server.inject({
      method: "POST",
      url: "/alerts/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { runnerId: "runner-verify" },
    });
    expect(res.statusCode).toBe(404);
  });
});
