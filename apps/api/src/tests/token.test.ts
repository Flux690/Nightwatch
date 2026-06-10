import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { registerTokenRoutes } from "../token/routes.js";

describe("GET /token", () => {
  let server: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    server = Fastify({ logger: false });
    await registerTokenRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns a non-empty deployment token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/token`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("is idempotent: the same token is returned on repeat reads", async () => {
    const first = (await (
      await fetch(`http://127.0.0.1:${port}/token`)
    ).json()) as { token: string };
    const second = (await (
      await fetch(`http://127.0.0.1:${port}/token`)
    ).json()) as { token: string };
    expect(second.token).toBe(first.token);
  });
});
