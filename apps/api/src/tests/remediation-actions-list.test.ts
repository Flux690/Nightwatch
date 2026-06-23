import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RemediationActionRecord } from "@nightwatch/shared";

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db/client.js";
import { registerRemediationRoutes } from "../remediation/routes.js";

function seedSession(sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'test', ?)`,
    )
    .run(sessionId, new Date().toISOString());
}

function seedRemediationAction(row: {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  serviceIdentityKey: string | null;
  status: string;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO remediation_actions
         (tool_use_id, session_id, tool_name, service_identity_key, status, resolved_by, input, created_at, resolved_at)
       VALUES
         (@toolUseId, @sessionId, @toolName, @serviceIdentityKey, @status, @resolvedBy, '{}', @createdAt, @resolvedAt)`,
    )
    .run(row);
}

describe("GET /remediation-actions", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await registerRemediationRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/remediation-actions`);
    expect(res.status).toBe(401);
  });

  it("returns recorded actions newest-first with identity, action, outcome, resolver, and timestamps", async () => {
    seedSession("sess-list-1");
    seedRemediationAction({
      toolUseId: "tu-list-older",
      sessionId: "sess-list-1",
      toolName: "restart_container",
      serviceIdentityKey: "docker/proj/web",
      status: "executed",
      resolvedBy: "operator",
      createdAt: "2024-01-01T00:00:00.000Z",
      resolvedAt: "2024-01-01T00:00:05.000Z",
    });
    seedRemediationAction({
      toolUseId: "tu-list-newer",
      sessionId: "sess-list-1",
      toolName: "exec_command",
      serviceIdentityKey: "kubernetes/ns/api",
      status: "rejected",
      resolvedBy: "console",
      createdAt: "2024-06-01T00:00:00.000Z",
      resolvedAt: "2024-06-01T00:00:00.000Z",
    });

    const res = await fetch(`http://127.0.0.1:${port}/remediation-actions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RemediationActionRecord[];

    const ours = body.filter((a) => a.toolUseId.startsWith("tu-list-"));
    expect(ours).toHaveLength(2);
    // Newest first.
    expect(ours[0].toolUseId).toBe("tu-list-newer");
    expect(ours[1].toolUseId).toBe("tu-list-older");

    expect(ours[0]).toEqual({
      toolUseId: "tu-list-newer",
      serviceIdentityKey: "kubernetes/ns/api",
      toolName: "exec_command",
      status: "rejected",
      resolvedBy: "console",
      createdAt: "2024-06-01T00:00:00.000Z",
      resolvedAt: "2024-06-01T00:00:00.000Z",
    });
  });
});
