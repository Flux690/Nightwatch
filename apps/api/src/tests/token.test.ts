import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";

import { registerTokenRoutes } from "../auth/token.js";
import { registerWsRoutes } from "../ws/server.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db/client.js";
import { generateRunnerToken } from "../db/runner.js";
import { createSession } from "../db/sessions.js";

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("Runner token lifecycle (issue 038)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
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
      const res = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { token: string; id: string };
      expect(body.token).toMatch(/^nwr_[A-Za-z0-9_-]{43}$/);
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores only the SHA-256 hash in the DB, never the plaintext", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token, id } = JSON.parse(res.body) as {
        token: string;
        id: string;
      };
      const row = getDb()
        .prepare("SELECT token FROM runner WHERE id = ?")
        .get(id) as { token: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.token).toBe(sha256hex(token));
      expect(row!.token).not.toContain("nwr_");
    });

    it("stores an optional label", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { label: "prod-server" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { label: string };
      expect(body.label).toBe("prod-server");
    });

    it("each generate produces a unique token", async () => {
      const a = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const b = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
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
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { label: "list-test" },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      const res = await server.inject({
        method: "GET",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(token);
    });

    it("includes id, label, createdAt, lastUsedAt", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { label: "meta-test" },
      });
      const { id } = JSON.parse(mint.body) as { id: string };

      const res = await server.inject({
        method: "GET",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { tokens } = JSON.parse(res.body) as {
        tokens: Array<{
          id: string;
          label: string | null;
          createdAt: string;
          lastUsedAt: string | null;
        }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found).toBeDefined();
      expect(found!.label).toBe("meta-test");
      expect(found!.createdAt).toBeTruthy();
      expect(found!.lastUsedAt).toBeNull();
    });
  });

  describe("DELETE /tokens/:id", () => {
    it("returns 204 and removes the token row entirely", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { label: "to-delete" },
      });
      const { id } = JSON.parse(mint.body) as { id: string };

      const del = await server.inject({
        method: "DELETE",
        url: `/tokens/${id}`,
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(del.statusCode).toBe(204);

      const list = await server.inject({
        method: "GET",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string }>;
      };
      expect(tokens.find((t) => t.id === id)).toBeUndefined();
    });

    it("returns 404 for unknown id", async () => {
      const res = await server.inject({
        method: "DELETE",
        url: "/tokens/00000000-0000-0000-0000-000000000000",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("denies reconnect with the deleted token", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await server.inject({
        method: "DELETE",
        url: `/tokens/${id}`,
        headers: { cookie: `nw_auth=${SESSION}` },
      });

      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4003));
      });
      expect(code).toBe(4003);
    });
  });

  describe("runner WS connect", () => {
    it("accepts a valid token and sends connected", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
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
          },
        });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4003));
      });
      expect(code).toBe(4003);
    });

    it("closes with 4001 when no Authorization header is sent", async () => {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`);
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4001));
      });
      expect(code).toBe(4001);
    });

    it("disconnects live runner sockets immediately on token delete", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      const closeCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", async (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            await server.inject({
              method: "DELETE",
              url: `/tokens/${id}`,
              headers: { cookie: `nw_auth=${SESSION}` },
            });
          }
        });
        ws.on("close", (c) => resolve(c));
      });
      expect(closeCode).toBe(4003);
    });
  });

  describe("lastUsedAt", () => {
    it("is set after a successful runner WS connect", async () => {
      const mint = await server.inject({
        method: "POST",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
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

      const list = await server.inject({
        method: "GET",
        url: "/tokens",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string; lastUsedAt: string | null }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found!.lastUsedAt).toBeTruthy();
    });
  });

  describe("session history after token deletion", () => {
    it("session row survives hard-deleting its runner token", async () => {
      const { id: tokenId } = generateRunnerToken("history-test");
      createSession(
        {
          sessionId: "sess-history-1",
          title: "history session",
          createdAt: new Date().toISOString(),
        },
        null,
      );

      await server.inject({
        method: "DELETE",
        url: `/tokens/${tokenId}`,
        headers: { cookie: `nw_auth=${SESSION}` },
      });

      const row = getDb()
        .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
        .get("sess-history-1") as { session_id: string } | undefined;
      expect(row).toBeDefined();
    });
  });
});
