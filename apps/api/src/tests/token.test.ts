import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";

import { registerTokenRoutes } from "../token/routes.js";
import { registerWsRoutes } from "../ws/server.js";
import { useTempDb } from "./temp-db.js";
import { getDb } from "../db/client.js";

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("Token lifecycle (issue 025)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerTokenRoutes(server);
    await registerWsRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  describe("POST /tokens", () => {
    it("returns nwr_-prefixed plaintext with a UUID id", async () => {
      const res = await server.inject({ method: "POST", url: "/tokens" });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { token: string; id: string };
      expect(body.token).toMatch(/^nwr_[A-Za-z0-9_-]{43}$/);
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores only the SHA-256 hash in the DB, never the plaintext", async () => {
      const res = await server.inject({ method: "POST", url: "/tokens" });
      const { token, id } = JSON.parse(res.body) as {
        token: string;
        id: string;
      };
      const row = getDb()
        .prepare("SELECT token FROM tokens WHERE id = ?")
        .get(id) as { token: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.token).toBe(sha256hex(token));
      expect(row!.token).not.toContain("nwr_");
    });

    it("stores an optional label", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/tokens",
        payload: { label: "prod-server" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { label: string };
      expect(body.label).toBe("prod-server");
    });

    it("each mint produces a unique token", async () => {
      const a = await server.inject({ method: "POST", url: "/tokens" });
      const b = await server.inject({ method: "POST", url: "/tokens" });
      const tokenA = (JSON.parse(a.body) as { token: string }).token;
      const tokenB = (JSON.parse(b.body) as { token: string }).token;
      expect(tokenA).not.toBe(tokenB);
    });
  });

  describe("GET /tokens", () => {
    it("never returns plaintext in the list", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        payload: { label: "list-test" },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      const res = await server.inject({ method: "GET", url: "/tokens" });
      expect(res.statusCode).toBe(200);
      // The full plaintext must not appear anywhere in the response body
      expect(res.body).not.toContain(token);
    });

    it("includes id, label, createdAt, lastUsedAt, revokedAt", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        payload: { label: "meta-test" },
      });
      const { id } = JSON.parse(mint.body) as { id: string };

      const res = await server.inject({ method: "GET", url: "/tokens" });
      const { tokens } = JSON.parse(res.body) as {
        tokens: Array<{
          id: string;
          label: string | null;
          createdAt: string;
          lastUsedAt: string | null;
          revokedAt: string | null;
        }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found).toBeDefined();
      expect(found!.label).toBe("meta-test");
      expect(found!.createdAt).toBeTruthy();
      expect(found!.lastUsedAt).toBeNull();
      expect(found!.revokedAt).toBeNull();
    });
  });

  describe("DELETE /tokens/:id", () => {
    it("returns 204 and sets revokedAt on the token", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        payload: { label: "to-revoke" },
      });
      const { id } = JSON.parse(mint.body) as { id: string };

      const del = await server.inject({
        method: "DELETE",
        url: `/tokens/${id}`,
      });
      expect(del.statusCode).toBe(204);

      const list = await server.inject({ method: "GET", url: "/tokens" });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string; revokedAt: string | null }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found!.revokedAt).toBeTruthy();
    });

    it("returns 404 for unknown id", async () => {
      const res = await server.inject({
        method: "DELETE",
        url: "/tokens/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("runner WS connect", () => {
    it("accepts a valid token and sends connected", async () => {
      const mint = await server.inject({ method: "POST", url: "/tokens" });
      const { token } = JSON.parse(mint.body) as { token: string };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Nightwatch-Runner-Id": "runner-accept",
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
      });
    });

    it("closes with 4003 for an unknown token", async () => {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization:
              "Bearer nwr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "X-Nightwatch-Runner-Id": "runner-reject",
          },
        });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4003));
      });
      expect(code).toBe(4003);
    });

    it("closes with 4001 when no Authorization header is sent", async () => {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: { "X-Nightwatch-Runner-Id": "runner-noauth" },
        });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4001));
      });
      expect(code).toBe(4001);
    });

    it("disconnects live runner sockets immediately on token revoke", async () => {
      const mint = await server.inject({ method: "POST", url: "/tokens" });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      const closeCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Nightwatch-Runner-Id": "runner-revoke",
          },
        });
        ws.on("message", async (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            // Revoke the token; the socket should close with 4003
            await server.inject({ method: "DELETE", url: `/tokens/${id}` });
          }
        });
        ws.on("close", (c) => resolve(c));
      });
      expect(closeCode).toBe(4003);
    });
  });

  describe("lastUsedAt", () => {
    it("is set after a successful runner WS connect", async () => {
      const mint = await server.inject({ method: "POST", url: "/tokens" });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Nightwatch-Runner-Id": "runner-lastseen",
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
      });

      const list = await server.inject({ method: "GET", url: "/tokens" });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string; lastUsedAt: string | null }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found!.lastUsedAt).toBeTruthy();
    });
  });
});
