import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { CapabilityManifest, RunnerRecord } from "@nightwatch/shared";
import { createToken } from "../db/tokens.js";
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

describe("multi-runner registry (token, runnerId)", () => {
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
    // A fresh token per test isolates the registry: a prior test's async socket
    // close cannot unregister this test's identically-named runner.
    const token = createToken("two-up").token;
    const a = await connectRunner(
      port,
      token,
      "runner-a",
      manifest(token, "runner-a", "web-01", ["nginx", "api"]),
    );
    const b = await connectRunner(
      port,
      token,
      "runner-b",
      manifest(token, "runner-b", "db-02", ["postgres"]),
    );

    // Both manifests must be stored before asserting; the sends above are async.
    const runners = await waitFor(async () => {
      const list = await getRunners();
      const mine = list.filter((r) => r.token === token);
      return mine.length === 2 && mine.every((r) => r.manifest !== null)
        ? mine
        : undefined;
    });

    const byId = new Map(runners.map((r) => [r.id, r]));
    const ra = byId.get("runner-a");
    const rb = byId.get("runner-b");
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();

    // One runner's manifest or hostname never overwrites the other's.
    expect(ra?.hostname).toBe("web-01");
    expect(rb?.hostname).toBe("db-02");
    expect(ra?.manifest?.capabilities.containers).toEqual(["nginx", "api"]);
    expect(rb?.manifest?.capabilities.containers).toEqual(["postgres"]);

    // Both are independently online (each has its own fresh heartbeat).
    expect(ra?.online).toBe(true);
    expect(rb?.online).toBe(true);

    a.close();
    b.close();
  });

  it("drops a runner from the fleet when its socket closes, leaving the other", async () => {
    const token = createToken("close-one").token;
    const a = await connectRunner(
      port,
      token,
      "runner-a",
      manifest(token, "runner-a", "web-01", ["nginx"]),
    );
    const b = await connectRunner(
      port,
      token,
      "runner-b",
      manifest(token, "runner-b", "db-02", ["postgres"]),
    );
    await waitFor(async () =>
      (await getRunners()).filter(
        (r) => r.token === token && r.manifest !== null,
      ).length === 2
        ? true
        : undefined,
    );

    a.close();

    // After a's socket closes only b remains live; the token still resolves to a
    // single online runner, not a phantom of the dead one.
    const remaining = await waitFor(async () => {
      const live = (await getRunners()).filter(
        (r) => r.token === token && r.online,
      );
      return live.length === 1 ? live : undefined;
    });
    expect(remaining[0].id).toBe("runner-b");

    b.close();
  });
});
