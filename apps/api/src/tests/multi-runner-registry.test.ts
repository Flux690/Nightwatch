import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type {
  CapabilityManifest,
  FleetRunner,
  RunnerRecord,
} from "@nightwatch/shared";
import { generateToken } from "../db/tokens.js";
import { mintTestSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { registerWsRoutes } from "../ws/server.js";
import { registerRunnerRoutes } from "../runners/routes.js";

function manifest(hostname: string, containers: string[]): CapabilityManifest {
  return {
    runnerId: `runner-${hostname}`,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: containers.map((name) => ({
        identity: { provider: "docker" as const, project: name, service: name },
        status: "running",
      })),
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: false,
    },
  };
}

// Connect a fake runner, wait for the server's `connected` ack, then send its
// manifest and a heartbeat. Returns the open socket so the test can close it.
async function connectRunner(
  port: number,
  token: string,
  m: CapabilityManifest,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "connected") resolve();
    });
  });
  ws.send(JSON.stringify({ messageId: "m", type: "manifest", payload: m }));
  ws.send(JSON.stringify({ messageId: "h", type: "heartbeat", payload: {} }));
  return ws;
}

describe("flat runner registry", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerWsRoutes(server);
    await registerRunnerRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await server.inject({ method: "GET", url: "/runners" });

    expect(res.statusCode).toBe(401);
  });

  async function getRunners(): Promise<RunnerRecord[]> {
    const res = await server.inject({
      method: "GET",
      url: "/runners",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as RunnerRecord[];
  }

  async function getFleet(): Promise<FleetRunner[]> {
    const res = await server.inject({
      method: "GET",
      url: "/fleet",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as FleetRunner[];
  }

  it("lists two runners each on their own token with correct manifests", async () => {
    const { plaintext: tokenA, id: tokenAId } = generateToken("one-up-a");
    const { plaintext: tokenB, id: tokenBId } = generateToken("one-up-b");
    const a = await connectRunner(
      port,
      tokenA,
      manifest("web-01", ["nginx", "api"]),
    );
    const b = await connectRunner(
      port,
      tokenB,
      manifest("db-02", ["postgres"]),
    );

    const runners = await waitFor(async () => {
      const list = await getRunners();
      const mine = list.filter(
        (r) => r.token === tokenAId || r.token === tokenBId,
      );
      return mine.length === 2 && mine.every((r) => r.manifest !== null)
        ? mine
        : undefined;
    });

    const byToken = new Map(runners.map((r) => [r.token, r]));
    const ra = byToken.get(tokenAId);
    const rb = byToken.get(tokenBId);
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();

    expect(ra?.hostname).toBe("web-01");
    expect(rb?.hostname).toBe("db-02");
    expect(ra?.manifest?.capabilities.services).toEqual([
      {
        identity: { provider: "docker", project: "nginx", service: "nginx" },
        status: "running",
      },
      {
        identity: { provider: "docker", project: "api", service: "api" },
        status: "running",
      },
    ]);
    expect(rb?.manifest?.capabilities.services).toEqual([
      {
        identity: {
          provider: "docker",
          project: "postgres",
          service: "postgres",
        },
        status: "running",
      },
    ]);
    expect(ra?.manifest).not.toHaveProperty("token");
    expect(rb?.manifest).not.toHaveProperty("token");

    expect(ra?.online).toBe(true);
    expect(rb?.online).toBe(true);

    a.close();
    b.close();
  });

  it("drops a runner from the fleet when its socket closes, leaving the other", async () => {
    const { plaintext: tokenA, id: tokenAId } = generateToken("close-one-a");
    const { plaintext: tokenB, id: tokenBId } = generateToken("close-one-b");
    const a = await connectRunner(port, tokenA, manifest("web-01", ["nginx"]));
    const b = await connectRunner(
      port,
      tokenB,
      manifest("db-02", ["postgres"]),
    );
    await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) =>
          (r.token === tokenAId || r.token === tokenBId) && r.manifest !== null,
      );
      return live.length === 2 ? true : undefined;
    });

    a.close();

    const remaining = await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => (r.token === tokenAId || r.token === tokenBId) && r.online,
      );
      return live.length === 1 ? live : undefined;
    });
    expect(remaining[0].token).toBe(tokenBId);

    b.close();
  });

  it("two runners on different tokens both appear in the fleet", async () => {
    const { plaintext: tokenA, id: tokenAId } = generateToken("cross-a");
    const { plaintext: tokenB, id: tokenBId } = generateToken("cross-b");

    const a = await connectRunner(port, tokenA, manifest("host-a", ["nginx"]));
    const b = await connectRunner(
      port,
      tokenB,
      manifest("host-b", ["postgres"]),
    );

    const runners = await waitFor(async () => {
      const list = await getRunners();
      const mine = list.filter(
        (r) => r.token === tokenAId || r.token === tokenBId,
      );
      return mine.length === 2 && mine.every((r) => r.manifest !== null)
        ? mine
        : undefined;
    });

    const byToken = new Map(runners.map((r) => [r.token, r]));
    expect(byToken.get(tokenAId)?.hostname).toBe("host-a");
    expect(byToken.get(tokenBId)?.hostname).toBe("host-b");
    expect(byToken.get(tokenAId)?.online).toBe(true);
    expect(byToken.get(tokenBId)?.online).toBe(true);

    a.close();
    b.close();
  });

  it("GET /fleet returns connected runners with their service identities, with no token-management fields", async () => {
    const { plaintext: tokenA } = generateToken("fleet-a");
    const { plaintext: tokenB } = generateToken("fleet-b");

    const a = await connectRunner(
      port,
      tokenA,
      manifest("web-01", ["nginx", "api"]),
    );
    const b = await connectRunner(
      port,
      tokenB,
      manifest("db-02", ["postgres"]),
    );

    const fleet = await waitFor(async () => {
      const list = await getFleet();
      const mine = list.filter(
        (r) => r.hostname === "web-01" || r.hostname === "db-02",
      );
      return mine.length === 2 ? mine : undefined;
    });

    const byHostname = new Map(fleet.map((r) => [r.hostname, r]));
    expect(byHostname.get("web-01")?.services).toEqual([
      {
        identity: { provider: "docker", project: "nginx", service: "nginx" },
        status: "running",
      },
      {
        identity: { provider: "docker", project: "api", service: "api" },
        status: "running",
      },
    ]);
    expect(byHostname.get("db-02")?.services).toEqual([
      {
        identity: {
          provider: "docker",
          project: "postgres",
          service: "postgres",
        },
        status: "running",
      },
    ]);
    expect(byHostname.get("web-01")?.online).toBe(true);
    expect(byHostname.get("web-01")).not.toHaveProperty("token");

    a.close();
    b.close();
  });
});
