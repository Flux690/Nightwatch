import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// Mock sendCommand — relay test only cares about call count and result
const { mockSendCommand } = vi.hoisted(() => ({
  mockSendCommand: vi.fn(),
}));

vi.mock("../ws/router.js", () => ({
  sendCommand: mockSendCommand,
  registerRunner: vi.fn(),
  unregisterRunner: vi.fn(),
  resolveCommand: vi.fn(),
  RunnerOfflineError: class RunnerOfflineError extends Error {
    constructor(token: string) {
      super(`Runner for token ${token} is offline`);
      this.name = "RunnerOfflineError";
    }
  },
}));

import { redis } from "../redis/client.js";
import { registerRelayRoutes } from "../relay/routes.js";

const TEST_TOKEN = "relay-test-token";
const QUERY = { type: "get_sessions", params: { token: TEST_TOKEN } } as const;
const SCRIPTED_RESULT = [{ sessionId: "s1", title: "Test session" }];

describe("relay + cache", () => {
  let server: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    mockSendCommand.mockResolvedValue(SCRIPTED_RESULT);

    server = Fastify({ logger: false });
    await registerRelayRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Clean up the cache key so reruns start fresh
    const cacheKey = `relay:${TEST_TOKEN}:${QUERY.type}:${JSON.stringify(QUERY.params)}`;
    await redis.del(cacheKey);
    await server.close();
  });

  it("calls sendCommand on first request and returns the result", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/client-query/${TEST_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(QUERY),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(SCRIPTED_RESULT);
    expect(mockSendCommand).toHaveBeenCalledOnce();
  });

  it("returns cached result on second request without calling sendCommand again", async () => {
    mockSendCommand.mockClear();

    const res = await fetch(
      `http://127.0.0.1:${port}/client-query/${TEST_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(QUERY),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(SCRIPTED_RESULT);
    expect(mockSendCommand).not.toHaveBeenCalled();
  });
});
