import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { registerConsoleWsRoutes } from "../ws/console.js";

async function buildServer(): Promise<{
  server: FastifyInstance;
  port: number;
}> {
  const server = Fastify({ logger: false, trustProxy: true });
  await server.register(FastifyWebSocket);
  await registerConsoleWsRoutes(server);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.server.address() as AddressInfo).port;
  return { server, port };
}

// Attempts a WS connection and resolves with: 1000 connected+closed normally; 4001 server
// close frame (code 4001); -1 HTTP-level rejection (error event, non-101 upgrade).
function connectWs(
  port: number,
  session: string,
  origin: string | undefined,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const headers: Record<string, string> = {
      Cookie: `nw_auth=${session}`,
    };
    if (origin !== undefined) headers["Origin"] = origin;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers,
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type === "connected") {
        ws.close();
        resolve(1000);
      }
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", () => resolve(-1));
  });
}

describe("console WS origin allow-list (default: localhost)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    ({ server, port } = await buildServer());
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("connects with Origin: http://localhost", async () => {
    const code = await connectWs(port, SESSION, "http://localhost");
    expect(code).toBe(1000);
  });

  it("connects with Origin: http://127.0.0.1", async () => {
    const code = await connectWs(port, SESSION, "http://127.0.0.1");
    expect(code).toBe(1000);
  });

  it("connects with a localhost origin on a non-standard port", async () => {
    const code = await connectWs(port, SESSION, "http://localhost:5173");
    expect(code).toBe(1000);
  });

  it("closes with 4001 for a disallowed origin", async () => {
    const code = await connectWs(port, SESSION, "https://evil.com");
    expect(code).toBe(4001);
  });

  it("closes with 4001 when no Origin header is sent", async () => {
    const code = await connectWs(port, SESSION, undefined);
    expect(code).toBe(4001);
  });

  it("rejects connection (HTTP 401) when session cookie is invalid", async () => {
    // requireSession preHandler sends HTTP 401 before WS is established
    const code = await connectWs(
      port,
      "not-a-valid-cookie",
      "http://localhost",
    );
    expect(code).toBe(-1);
  });
});

describe("console WS origin allow-list (custom CONSOLE_ORIGINS)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    vi.stubEnv("CONSOLE_ORIGINS", "https://nightwatch.example.com");
    ({ server, port } = await buildServer());
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("connects with the configured origin", async () => {
    const code = await connectWs(
      port,
      SESSION,
      "https://nightwatch.example.com",
    );
    expect(code).toBe(1000);
  });

  it("closes with 4001 for a localhost origin when not in the allow-list", async () => {
    const code = await connectWs(port, SESSION, "http://localhost");
    expect(code).toBe(4001);
  });

  it("closes with 4001 for a missing origin", async () => {
    const code = await connectWs(port, SESSION, undefined);
    expect(code).toBe(4001);
  });
});

describe("console WS origin allow-list (multiple CONSOLE_ORIGINS)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    vi.stubEnv(
      "CONSOLE_ORIGINS",
      "https://nightwatch.example.com,https://admin.example.com",
    );
    ({ server, port } = await buildServer());
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("connects with the first configured origin", async () => {
    const code = await connectWs(
      port,
      SESSION,
      "https://nightwatch.example.com",
    );
    expect(code).toBe(1000);
  });

  it("connects with the second configured origin", async () => {
    const code = await connectWs(port, SESSION, "https://admin.example.com");
    expect(code).toBe(1000);
  });

  it("closes with 4001 for an origin not in the list", async () => {
    const code = await connectWs(port, SESSION, "https://other.example.com");
    expect(code).toBe(4001);
  });
});
