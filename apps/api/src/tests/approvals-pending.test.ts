import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ApprovalRequest } from "@nightwatch/shared";
import {
  requestApproval,
  resolveApproval,
} from "../investigation/approvals.js";
import { registerApprovalRoutes } from "../approvals/routes.js";

describe("GET /approvals/pending", () => {
  let server: FastifyInstance;
  let port: number;
  const TOKEN_A = `tok-a-${randomUUID()}`;
  const TOKEN_B = `tok-b-${randomUUID()}`;

  beforeAll(async () => {
    server = Fastify({ logger: false });
    await registerApprovalRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns pre-existing pending approvals for the given token on first load", async () => {
    const incidentId = `inc-${randomUUID()}`;
    const toolUseId = `tool-${randomUUID()}`;

    // Seed a pending approval without awaiting — the approval gate is in-flight
    void requestApproval(TOKEN_A, incidentId, {
      id: toolUseId,
      name: "restart_container",
      input: { containerName: "web-01" },
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/approvals/pending?token=${TOKEN_A}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApprovalRequest[];
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((a) => a.incidentId === incidentId);
    expect(found).toBeDefined();
    expect(found?.toolName).toBe("restart_container");
    expect(found?.status).toBe("pending");

    // Cleanup: resolve so requestApproval doesn't hang the test suite
    resolveApproval({ toolUseId, action: "reject" });
  });

  it("scopes results to the queried token — different token returns empty", async () => {
    const incidentId = `inc-${randomUUID()}`;
    const toolUseId = `tool-${randomUUID()}`;

    void requestApproval(TOKEN_B, incidentId, {
      id: toolUseId,
      name: "restart_container",
      input: { containerName: "db-01" },
    });

    const res = await fetch(
      `http://127.0.0.1:${port}/approvals/pending?token=${TOKEN_A}`,
    );
    const body = (await res.json()) as ApprovalRequest[];
    const found = body.find((a) => a.incidentId === incidentId);
    expect(found).toBeUndefined();

    resolveApproval({ toolUseId, action: "reject" });
  });

  it("returns 400 when token query param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/approvals/pending`);
    expect(res.status).toBe(400);
  });
});
