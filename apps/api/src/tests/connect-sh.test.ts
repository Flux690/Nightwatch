import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { generateRunnerToken } from "../db/runner.js";
import { registerConnectRoutes } from "../runners/connect.js";
import { mountApi } from "./api-server.js";

describe("GET /connect.sh", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;
  let TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TOKEN = generateRunnerToken("test-server").plaintext;
    server = Fastify({ logger: false, trustProxy: true });
    await mountApi(server, registerConnectRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when the Authorization header is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not accept the token as a query parameter", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/connect.sh?token=${TOKEN}`,
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a token not in the DB", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: "Bearer nwr_notarealtoken_just_a_fake_value_xxxx",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a shell script with Content-Type text/x-shellscript", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/x-shellscript/);
  });

  it("script contains the ws:// runner WS URL", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "control.example.com:3000",
      },
    });
    expect(res.body).toContain(
      "ws://control.example.com:3000/api/clients/connect",
    );
  });

  it("uses wss:// for https requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "my-host.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(res.body).toContain("wss://my-host.example.com/api/clients/connect");
  });

  it("bakes in PUBLIC_URL over the request Host, so a runner dials the address that is reachable from its own machine", async () => {
    vi.stubEnv("PUBLIC_URL", "https://nightwarden.example.com");
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/connect.sh",
        headers: {
          cookie: `nw_auth=${SESSION}`,
          authorization: `Bearer ${TOKEN}`,
          // What an operator's browser reached the console on: useless to a runner.
          host: "localhost:3000",
        },
      });

      expect(res.body).toContain(
        "wss://nightwarden.example.com/api/clients/connect",
      );
      expect(res.body).not.toContain("localhost:3000");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("script contains the runner token", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).toContain(TOKEN);
  });

  it("carries no bundled-monitoring plumbing (unbundled runner)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    // No sidecar ports, no monitoring env, no ingest credential - alert wiring
    // now lives entirely on the console's Alertmanager page.
    for (const token of [
      "9090",
      "9093",
      "8080",
      "prometheus",
      "alertmanager",
      "cadvisor",
      "PROMETHEUS_URL",
      "ALERTMANAGER_URL",
      "NIGHTWARDEN_INGEST_TOKEN",
      "PLATFORM_URL",
      "nightwarden.sh",
      "inst_",
    ]) {
      expect(res.body).not.toContain(token);
    }
  });

  it("passes only what the runner reads: token, ws url, and the host /proc mount", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });

    expect(res.body).toContain('-e "NIGHTWARDEN_TOKEN=');
    expect(res.body).toContain('-e "WS_URL=');
    expect(res.body).toContain('-e "HOST_PROC=/host/proc"');
    // The runner takes its advertised name from the host's own /proc, so the
    // script needs no name baked in and none can be copied wrong.
    expect(res.body).not.toContain("--hostname");
    expect(res.body).toContain("-v /proc:/host/proc:ro");
  });
});
