import { createHash } from "node:crypto";
import { harness, type Harness } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { registerTokenRoutes } from "../auth/token.js";
import { registerWsRoutes } from "../fleet/server.js";
import { getDb } from "../db.js";
import { generateRunnerToken, touchLastUsed } from "../fleet/runners-store.js";
import { createSession } from "../session/store.js";

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("Runner token lifecycle (issue 038)", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({ routes: [registerTokenRoutes, registerWsRoutes] });
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  describe("POST /tokens", () => {
    it("returns nwr_-prefixed plaintext with a UUID id", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-01" },
        headers: { cookie: `${SESSION}` },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { token: string; id: string };
      expect(body.token).toMatch(/^nwr_[A-Za-z0-9_-]{43}$/);
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores only the SHA-256 hash in the DB, never the plaintext", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-02" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(res.body) as {
        token: string;
        id: string;
      };
      const row = await getDb()
        .selectFrom("runner")
        .select("token")
        .where("id", "=", id)
        .executeTakeFirst();
      expect(row).toBeDefined();
      expect(row!.token).toBe(sha256hex(token));
      expect(row!.token).not.toContain("nwr_");
    });

    // A runner that does not know what it is at mint time is the defect this
    // column exists to prevent, so there is no default to fall back on.
    it("refuses to mint without a platform", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { serverName: "no-platform" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining("platform"),
      });
    });

    it("refuses a platform it does not recognise", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "nomad" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("stores the platform on the row and returns it", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "kubernetes", serverName: "prod-cluster" },
      });
      expect(res.statusCode).toBe(201);
      const { id, platform } = JSON.parse(res.body) as {
        id: string;
        platform: string;
      };
      expect(platform).toBe("kubernetes");
      const row = await getDb()
        .selectFrom("runner")
        .select("platform")
        .where("id", "=", id)
        .executeTakeFirst();
      expect(row?.platform).toBe("kubernetes");
    });

    it("stores and returns serverName when provided", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-01" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { serverName: string };
      expect(body.serverName).toBe("web-01");
    });

    // The name is the first segment of every key this runner will advertise, so
    // a nameless runner has nothing to address its services by.
    it("returns 400 when serverName is absent", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining("serverName"),
      });
    });

    it("returns 400 when serverName is empty", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when serverName contains a forward slash", async () => {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "prod/web-01" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("reclaims a server name whose runner never connected (abandoned setup)", async () => {
      const first = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "db-server-01" },
      });
      const { id: firstId } = JSON.parse(first.body) as { id: string };

      const second = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "db-server-01" },
      });
      expect(second.statusCode).toBe(201);

      // The abandoned orphan is gone; only the fresh reservation holds the name.
      const rows = await getDb()
        .selectFrom("runner")
        .select("id")
        .where("server_name", "=", "db-server-01")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(firstId);
    });

    it("returns 409 when the server name belongs to a runner that has connected", async () => {
      const first = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-prod-01" },
      });
      const { id } = JSON.parse(first.body) as { id: string };
      // Simulate the runner manifesting (manifest handler sets last_used_at).
      await touchLastUsed(id);

      const res = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "web-prod-01" },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("GET /tokens", () => {
    it("never returns plaintext in the list", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: {
          platform: "docker",
          label: "list-test",
          serverName: "srv-03",
        },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      const res = await nw.server.inject({
        method: "GET",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-04" },
        headers: { cookie: `${SESSION}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(token);
    });
  });

  describe("DELETE /tokens/:id", () => {
    it("returns 204 and removes the token row entirely", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: {
          platform: "docker",
          label: "to-delete",
          serverName: "srv-05",
        },
      });
      const { id } = JSON.parse(mint.body) as { id: string };

      const del = await nw.server.inject({
        method: "DELETE",
        url: `/api/tokens/${id}`,
        headers: { cookie: `${SESSION}` },
      });
      expect(del.statusCode).toBe(204);

      const list = await nw.server.inject({
        method: "GET",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-06" },
        headers: { cookie: `${SESSION}` },
      });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string }>;
      };
      expect(tokens.find((t) => t.id === id)).toBeUndefined();
    });

    it("returns 404 for unknown id", async () => {
      const res = await nw.server.inject({
        method: "DELETE",
        url: "/api/tokens/00000000-0000-0000-0000-000000000000",
        headers: { cookie: `${SESSION}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("denies reconnect with the deleted token", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-07" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await nw.server.inject({
        method: "DELETE",
        url: `/api/tokens/${id}`,
        headers: { cookie: `${SESSION}` },
      });

      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
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
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-08" },
        headers: { cookie: `${SESSION}` },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
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

    // A disagreement is a real user error, the Docker install line pasted into
    // a cluster, so it is refused rather than half-served.
    it("refuses a runner whose manifest contradicts its row", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "mismatch-host" },
        headers: { cookie: `${SESSION}` },
      });
      const { token } = JSON.parse(mint.body) as { token: string };

      const { code, reason } = await new Promise<{
        code: number;
        reason: string;
      }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              messageId: "m1",
              type: "manifest",
              payload: {
                platform: "kubernetes",
                hostname: "some-cluster",
                runnerVersion: "3.0.0",
                services: [],
              },
            }),
          );
        });
        ws.on("close", (c, r) => resolve({ code: c, reason: String(r) }));
        ws.on("error", () => resolve({ code: 0, reason: "" }));
      });

      expect(code).toBe(4004);
      expect(reason).toMatch(/docker/);
      expect(reason).toMatch(/kubernetes/);
    });

    it("closes with 4003 for an unknown token", async () => {
      const code = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
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
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`);
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => resolve(4001));
      });
      expect(code).toBe(4001);
    });

    it("disconnects live runner sockets immediately on token delete", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-09" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      const closeCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", async (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            await nw.server.inject({
              method: "DELETE",
              url: `/api/tokens/${id}`,
              headers: { cookie: `${SESSION}` },
            });
          }
        });
        ws.on("close", (c) => resolve(c));
      });
      expect(closeCode).toBe(4003);
    });
  });

  describe("lastUsedAt", () => {
    it("is set after the runner sends its manifest", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-10" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type === "connected") {
            ws.send(
              JSON.stringify({
                type: "manifest",
                payload: {
                  platform: "docker",
                  hostname: "test-host",
                  runnerVersion: "2.0.0",
                  services: [],
                },
              }),
            );
            // Give the server one event-loop tick to process the manifest before closing.
            setTimeout(() => {
              ws.close();
              resolve();
            }, 20);
          }
        });
        ws.on("error", reject);
      });

      const list = await nw.server.inject({
        method: "GET",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-11" },
        headers: { cookie: `${SESSION}` },
      });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string; lastUsedAt: string | null }>;
      };
      const found = tokens.find((t) => t.id === id);
      expect(found!.lastUsedAt).toBeTruthy();
    });

    // A runner whose platform API is down authenticates but never manifests.
    it("is set when the runner authenticates, before any manifest arrives", async () => {
      const mint = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { platform: "docker", serverName: "srv-12" },
        headers: { cookie: `${SESSION}` },
      });
      const { token, id } = JSON.parse(mint.body) as {
        token: string;
        id: string;
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients/connect`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.on("message", (raw) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          // No manifest is ever sent: the daemon it would enumerate is down.
          if (msg.type === "connected") {
            setTimeout(() => {
              ws.close();
              resolve();
            }, 20);
          }
        });
        ws.on("error", reject);
      });

      const list = await nw.server.inject({
        method: "GET",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
      });
      const { tokens } = JSON.parse(list.body) as {
        tokens: Array<{ id: string; lastUsedAt: string | null }>;
      };
      expect(tokens.find((t) => t.id === id)!.lastUsedAt).toBeTruthy();

      // So its name is no longer free, and the live runner keeps its token.
      const second = await nw.server.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { cookie: `${SESSION}` },
        payload: { platform: "docker", serverName: "srv-12" },
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("session history after token deletion", () => {
    it("session row survives hard-deleting its runner token", async () => {
      const { id: runnerId } = await generateRunnerToken(
        "docker",
        "history-test",
      );
      await createSession({
        sessionId: "sess-history-1",
        title: "history session",
        createdAt: new Date().toISOString(),
      });

      await nw.server.inject({
        method: "DELETE",
        url: `/api/tokens/${runnerId}`,
        headers: { cookie: `${SESSION}` },
      });

      const row = await getDb()
        .selectFrom("sessions")
        .select("session_id")
        .where("session_id", "=", "sess-history-1")
        .executeTakeFirst();
      expect(row).toBeDefined();
    });
  });
});
