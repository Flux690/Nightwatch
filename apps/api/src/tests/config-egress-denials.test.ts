import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const { MockDocker } = vi.hoisted(() => ({ MockDocker: vi.fn() }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import { registerConfigRoutes } from "../config/routes.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";

const proxyLogs = {
  text: "BLOCKED evil.example.com\nBLOCKED cdn.foo.com\nBLOCKED evil.example.com\n",
  hasProxy: true,
};

function installDockerMock(): void {
  MockDocker.mockImplementation(function () {
    return {
      listContainers: () =>
        Promise.resolve(
          proxyLogs.hasProxy
            ? [
                {
                  Id: "proxy-1",
                  Labels: { "nightwatch.sandbox.proxy": "1" },
                  State: "running",
                },
              ]
            : [],
        ),
      getContainer: () => ({
        // Plain-text buffer: demux falls back to raw UTF-8 when the first byte
        // isn't a stream-type header, which is what a real non-TTY log tail is.
        logs: () => Promise.resolve(Buffer.from(proxyLogs.text)),
      }),
    };
  });
}

describe("GET /config/sandbox/egress-denials", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    vi.stubEnv("SECRET_KEY", "test-secret-key-for-aes256-gcm-!!!");
    SESSION = await mintTestSession();
    installDockerMock();
    server = Fastify({ logger: false });
    await registerConfigRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the distinct recently-blocked hosts, newest first", async () => {
    proxyLogs.hasProxy = true;
    const res = await server.inject({
      method: "GET",
      url: "/config/sandbox/egress-denials",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      hosts: ["evil.example.com", "cdn.foo.com"],
    });
  });

  it("returns an empty list when no proxy is running", async () => {
    proxyLogs.hasProxy = false;
    const res = await server.inject({
      method: "GET",
      url: "/config/sandbox/egress-denials",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hosts: [] });
  });

  it("requires a session", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/config/sandbox/egress-denials",
    });
    expect(res.statusCode).toBe(401);
  });
});
