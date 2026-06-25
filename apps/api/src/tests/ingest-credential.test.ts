import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { registerIngestCredentialRoutes } from "../auth/ingest-credential.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db/client.js";

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("Fleet-wide ingest credential", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await registerIngestCredentialRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  describe("POST /ingest-credential", () => {
    it("returns an nwi_-prefixed plaintext credential", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { token: string };
      expect(body.token).toMatch(/^nwi_[A-Za-z0-9_-]{43}$/);
    });

    it("stores only the SHA-256 hash in user.ingest_token_hash, never the plaintext", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token } = JSON.parse(res.body) as { token: string };
      const row = getDb()
        .prepare("SELECT ingest_token_hash FROM user WHERE id = 'global'")
        .get() as { ingest_token_hash: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.ingest_token_hash).toBe(sha256hex(token));
      expect(row!.ingest_token_hash).not.toContain("nwi_");
    });

    it("rotating replaces the hash so the old credential stops working", async () => {
      const first = await server.inject({
        method: "POST",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token: oldToken } = JSON.parse(first.body) as { token: string };

      const second = await server.inject({
        method: "POST",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token: newToken } = JSON.parse(second.body) as {
        token: string;
      };

      expect(newToken).not.toBe(oldToken);
      const row = getDb()
        .prepare("SELECT ingest_token_hash FROM user WHERE id = 'global'")
        .get() as { ingest_token_hash: string };
      expect(row.ingest_token_hash).toBe(sha256hex(newToken));
      expect(row.ingest_token_hash).not.toBe(sha256hex(oldToken));
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/ingest-credential",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /ingest-credential", () => {
    it("reports configured: false before any credential is generated", async () => {
      cleanupDb();
      cleanupDb = useTempDb();
      const res = await server.inject({
        method: "GET",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ configured: false, token: null });
    });

    it("reveals the plaintext of an existing credential for the wizard", async () => {
      const postRes = await server.inject({
        method: "POST",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const { token: generated } = JSON.parse(postRes.body) as {
        token: string;
      };

      const res = await server.inject({
        method: "GET",
        url: "/ingest-credential",
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      const body = JSON.parse(res.body) as {
        configured: boolean;
        token: string | null;
      };
      expect(body.configured).toBe(true);
      expect(body.token).toBe(generated);
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/ingest-credential",
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
