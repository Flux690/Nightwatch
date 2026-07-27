import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ConfigHealth } from "@nightwarden/shared";

import { registerConfigHealthRoutes } from "../config/health.js";
import { clearTestLLM, configureTestLLM, useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { generateAlertSourceToken } from "../db/alert-sources.js";
import {
  deletePrometheusIntegration,
  savePrometheusIntegration,
} from "../db/integrations.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { mountApi } from "./api-server.js";

function dockerManifest(hostname: string) {
  return {
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: [
        {
          identity: {
            provider: "docker" as const,
            project: "app",
            service: "svc",
          },
          status: "running",
        },
      ],
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: false,
    },
  };
}

describe("config health", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;
  const runners: RunnerConnection[] = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerConfigHealthRoutes);
    await server.ready();
  });

  afterEach(() => {
    for (const conn of runners.splice(0)) unregisterRunner(conn);
    deletePrometheusIntegration();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  async function fetchHealth(): Promise<ConfigHealth> {
    const res = await server.inject({
      method: "GET",
      url: "/api/config/health",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    return res.json() as ConfigHealth;
  }

  function connectDocker(id: string, serverName: string): void {
    const conn = registerRunner(
      id,
      () => {},
      () => {},
      serverName,
    );
    setRunnerManifest(id, dockerManifest(`${serverName}-host`));
    runners.push(conn);
  }

  it("flags an alert source with no evidence source", async () => {
    generateAlertSourceToken("alertmanager");
    const { issues } = await fetchHealth();
    expect(issues.map((i) => i.kind)).toContain("no-evidence-source");
  });

  it("clears once a runner (evidence source) is connected", async () => {
    generateAlertSourceToken("alertmanager");
    connectDocker("ch-runner-1", "prod-1");
    const { issues } = await fetchHealth();
    expect(issues.map((i) => i.kind)).not.toContain("no-evidence-source");
  });

  it("flags a server missing its nw_server label on a multi-server fleet", async () => {
    generateAlertSourceToken("alertmanager");
    connectDocker("ch-runner-1", "prod-1");
    connectDocker("ch-runner-2", "prod-2");
    savePrometheusIntegration({
      baseUrl: "http://prom.test",
      authHeaderEncrypted: null,
    });
    // Prometheus reports only prod-1 carries nw_server; prod-2 is missing.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "success", data: ["prod-1"] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    const { issues } = await fetchHealth();
    const missing = issues.find((i) => i.kind === "missing-server-label");
    expect(missing).toBeDefined();
    expect(missing?.message).toContain("prod-2");
  });

  describe("with no language model configured", () => {
    afterEach(() => {
      configureTestLLM();
    });

    it("raises llm-not-configured pointing at Settings, since nothing can be investigated without a model", async () => {
      clearTestLLM();

      const { issues } = await fetchHealth();

      const issue = issues.find((i) => i.kind === "llm-not-configured");
      expect(issue).toBeDefined();
      expect(issue?.href).toBe("/settings");
      expect(issue?.message).toMatch(/provider/i);
      expect(issue?.message).toMatch(/model/i);
    });
  });
});
