import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { CapabilityManifest, RunnerRecord } from "@nightwatch/shared";
import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { registerWsRoutes } from "../ws/server.js";
import { registerRunnerRoutes } from "../runners/routes.js";

function manifest(
  token: string,
  runnerId: string,
  hostname: string,
  containers: string[],
): CapabilityManifest {
  return {
    runnerId,
    token,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      containers,
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
  runnerId: string,
  m: CapabilityManifest,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-nightwatch-runner-id": runnerId,
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

  beforeAll(async () => {
    cleanupDb = useTempDb();
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

  async function getRunners(): Promise<RunnerRecord[]> {
    const res = await server.inject({ method: "GET", url: "/runners" });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as RunnerRecord[];
  }

  it("lists two runners on one token with independent manifests and liveness", async () => {
    // runnerId values are unique per test: the flat registry is keyed by runnerId
    // globally, so collisions across tests would corrupt each other's state.
    const { plaintext: token, id: tokenId } = mintToken("two-up");
    const a = await connectRunner(
      port,
      token,
      "two-up-a",
      manifest(token, "two-up-a", "web-01", ["nginx", "api"]),
    );
    const b = await connectRunner(
      port,
      token,
      "two-up-b",
      manifest(token, "two-up-b", "db-02", ["postgres"]),
    );

    const runners = await waitFor(async () => {
      const list = await getRunners();
      const mine = list.filter((r) => r.token === tokenId);
      return mine.length === 2 && mine.every((r) => r.manifest !== null)
        ? mine
        : undefined;
    });

    const byId = new Map(runners.map((r) => [r.id, r]));
    const ra = byId.get("two-up-a");
    const rb = byId.get("two-up-b");
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();

    expect(ra?.hostname).toBe("web-01");
    expect(rb?.hostname).toBe("db-02");
    expect(ra?.manifest?.capabilities.containers).toEqual(["nginx", "api"]);
    expect(rb?.manifest?.capabilities.containers).toEqual(["postgres"]);

    expect(ra?.online).toBe(true);
    expect(rb?.online).toBe(true);

    a.close();
    b.close();
  });

  it("drops a runner from the fleet when its socket closes, leaving the other", async () => {
    const { plaintext: token, id: tokenId } = mintToken("close-one");
    const a = await connectRunner(
      port,
      token,
      "close-one-a",
      manifest(token, "close-one-a", "web-01", ["nginx"]),
    );
    const b = await connectRunner(
      port,
      token,
      "close-one-b",
      manifest(token, "close-one-b", "db-02", ["postgres"]),
    );
    await waitFor(async () =>
      (await getRunners()).filter(
        (r) => r.token === tokenId && r.manifest !== null,
      ).length === 2
        ? true
        : undefined,
    );

    a.close();

    const remaining = await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => r.token === tokenId && r.online,
      );
      return live.length === 1 ? live : undefined;
    });
    expect(remaining[0].id).toBe("close-one-b");

    b.close();
  });

  it("two runners on different tokens both appear in the fleet", async () => {
    const { plaintext: tokenA, id: tokenAId } = mintToken("cross-a");
    const { plaintext: tokenB, id: tokenBId } = mintToken("cross-b");

    const a = await connectRunner(
      port,
      tokenA,
      "cross-runner-a",
      manifest(tokenA, "cross-runner-a", "host-a", ["nginx"]),
    );
    const b = await connectRunner(
      port,
      tokenB,
      "cross-runner-b",
      manifest(tokenB, "cross-runner-b", "host-b", ["postgres"]),
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

    const byId = new Map(runners.map((r) => [r.id, r]));
    expect(byId.get("cross-runner-a")?.hostname).toBe("host-a");
    expect(byId.get("cross-runner-b")?.hostname).toBe("host-b");
    expect(byId.get("cross-runner-a")?.online).toBe(true);
    expect(byId.get("cross-runner-b")?.online).toBe(true);

    a.close();
    b.close();
  });
});
