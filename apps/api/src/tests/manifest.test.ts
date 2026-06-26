import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { generateRunnerToken } from "../db/runner.js";
import { buildManifest, registerManifestRoutes } from "../runners/manifest.js";

describe("buildManifest", () => {
  it("inserts the WS URL into the manifest", () => {
    const yaml = buildManifest(
      "wss://control.example.com/clients/connect",
      "nwr_abc123",
    );
    expect(yaml).toContain("wss://control.example.com/clients/connect");
  });

  it("inserts the runner token into the manifest", () => {
    const yaml = buildManifest(
      "wss://control.example.com/clients/connect",
      "nwr_abc123",
    );
    expect(yaml).toContain("nwr_abc123");
  });

  it("does not leave any unreplaced placeholders", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok_xyz",
    );
    expect(yaml).not.toContain("{{");
    expect(yaml).not.toContain("}}");
  });

  it("creates the nightwatch namespace", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("kind: Namespace");
    expect(yaml).toContain("name: nightwatch");
  });

  it("includes a single-replica Deployment", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("kind: Deployment");
    expect(yaml).toContain("replicas: 1");
  });

  it("includes a ServiceAccount", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("kind: ServiceAccount");
  });

  it("includes ClusterRole and ClusterRoleBinding for read access", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).toContain("kind: ClusterRoleBinding");
  });

  it("grants read access to required resources", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("pods");
    expect(yaml).toContain("deployments");
    expect(yaml).toContain("statefulsets");
    expect(yaml).toContain("daemonsets");
    expect(yaml).toContain("replicasets");
    expect(yaml).toContain("events");
    expect(yaml).toContain("nodes");
    expect(yaml).toContain("namespaces");
  });

  it("grants log read access", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("pods/log");
  });

  it("grants write access to deployments and statefulsets", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("patch");
  });

  it("write ClusterRole grants create on pods/exec", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    const writeStart = yaml.indexOf("name: nightwatch-runner-write");
    const writeEnd = yaml.indexOf("---", writeStart);
    const writeRole = yaml.slice(writeStart, writeEnd);
    expect(writeRole).toContain("pods/exec");
    expect(writeRole).toContain('"create"');
  });

  it("uses the correct env var names that the runner reads", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("NIGHTWATCH_TOKEN");
    expect(yaml).toContain("WS_URL");
  });

  it("documents REMEDIATION_ENABLED as an optional env var", () => {
    const yaml = buildManifest(
      "wss://api.example.com/clients/connect",
      "nwr_tok",
    );
    expect(yaml).toContain("REMEDIATION_ENABLED");
  });

  it("substitutes different values correctly", () => {
    const wsUrl = "wss://nightwatch.internal:8443/clients/connect";
    const token = "nwr_verylongtoken_withspecialchars-123";
    const yaml = buildManifest(wsUrl, token);
    expect(yaml).toContain(wsUrl);
    expect(yaml).toContain(token);
  });
});

describe("GET /manifest.yaml", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;
  let TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TOKEN = generateRunnerToken("k8s-server").plaintext;
    server = Fastify({ logger: false, trustProxy: true });
    await registerManifestRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when the Authorization header is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a token not in the DB", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: "Bearer nwr_notarealtoken_just_a_fake_value_xxxx",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with Content-Type application/yaml", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "control.example.com",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/yaml/);
  });

  it("WS_URL uses ws:// for plain HTTP requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "control.example.com:3000",
      },
    });
    expect(res.body).toContain("ws://control.example.com:3000/clients/connect");
  });

  it("WS_URL uses wss:// when the request is forwarded over TLS", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
        host: "nightwatch.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(res.body).toContain("wss://nightwatch.example.com/clients/connect");
  });

  it("manifest contains the runner token as NIGHTWATCH_TOKEN", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).toContain(TOKEN);
  });

  it("manifest contains no unreplaced placeholders", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/manifest.yaml",
      headers: {
        cookie: `nw_auth=${SESSION}`,
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.body).not.toContain("{{");
    expect(res.body).not.toContain("}}");
  });
});
