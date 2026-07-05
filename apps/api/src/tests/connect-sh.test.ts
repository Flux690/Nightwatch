import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { generateRunnerToken } from "../db/runner.js";
import { registerConnectRoutes } from "../runners/connect.js";

describe("GET /connect.sh", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;
  let TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TOKEN = generateRunnerToken("test-server").plaintext;
    server = Fastify({ logger: false, trustProxy: true });
    await registerConnectRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when the Authorization header is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not accept the token as a query parameter", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/connect.sh?token=${TOKEN}`,
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a token not in the DB", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: "Bearer nwr_notarealtoken_just_a_fake_value_xxxx",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a shell script with Content-Type text/x-shellscript", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/x-shellscript/);
  });

  it("script contains the baked-in platform origin", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "control.example.com:3000",
      },
    });
    expect(res.body).toContain("http://control.example.com:3000");
  });

  it("script contains the ws:// runner WS URL", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "control.example.com:3000",
      },
    });
    expect(res.body).toContain("ws://control.example.com:3000/clients/connect");
  });

  it("uses wss:// for https requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "my-host.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(res.body).toContain("https://my-host.example.com");
    expect(res.body).toContain("wss://my-host.example.com/clients/connect");
  });

  it("script contains the runner token", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).toContain(TOKEN);
  });

  it("script prints header-based Alertmanager config instead of a token query parameter", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });

    expect(res.body).not.toContain("/alerts/ingest?token=");
    expect(res.body).toContain("authorization:");
    expect(res.body).toContain("credentials: '${NIGHTWATCH_INGEST_TOKEN}'");
  });

  it("bakes in the fleet ingest token and passes it to the container", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).toMatch(/NIGHTWATCH_INGEST_TOKEN="nwi_[^"]+"/);
    expect(res.body).toContain(
      "NIGHTWATCH_INGEST_TOKEN=${NIGHTWATCH_INGEST_TOKEN}",
    );
  });

  it("reuses one fleet ingest token across servers", async () => {
    const ingestOf = async (token: string): Promise<string> => {
      const res = await server.inject({
        method: "GET",
        url: "/connect.sh",
        headers: {
          cookie: `nw_auth=${SESSION}`,
          authorization: `Bearer ${token}`,
        },
      });
      const match = /NIGHTWATCH_INGEST_TOKEN="(nwi_[^"]+)"/.exec(res.body);
      if (match === null) throw new Error("ingest token not baked into script");
      return match[1];
    };

    const second = generateRunnerToken("second-server").plaintext;
    expect(await ingestOf(TOKEN)).toBe(await ingestOf(second));
  });

  it("script contains neither nightwatch.sh nor inst_", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).not.toContain("nightwatch.sh");
    expect(res.body).not.toContain("inst_");
  });

  it("script contains NIGHTWATCH_SERVER_NAME baked in from the token's server name", async () => {
    const namedToken = generateRunnerToken(
      "named-server",
      "prod-web-01",
    ).plaintext;
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${namedToken}`,
      },
    });
    expect(res.body).toContain('NIGHTWATCH_SERVER_NAME="prod-web-01"');
  });

  it("script passes NIGHTWATCH_SERVER_NAME env var to the Docker container", async () => {
    const namedToken = generateRunnerToken(
      "named-server-2",
      "staging-api-01",
    ).plaintext;
    const res = await server.inject({
      method: "GET",
      url: "/connect.sh",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${namedToken}`,
      },
    });
    expect(res.body).toContain(
      "NIGHTWATCH_SERVER_NAME=${NIGHTWATCH_SERVER_NAME}",
    );
  });
});
