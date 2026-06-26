import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
import { dispatcher } from "../dispatcher.js";
import type { CapabilityManifest, NormalizedAlert } from "@nightwatch/shared";

const FINISH: ScriptedTurn = { toolUses: [], text: "Investigation complete." };

function dockerManifest(
  runnerId: string,
  hostname: string,
  serviceNames: string[],
): CapabilityManifest {
  return {
    runnerId,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: serviceNames.map((name) => ({
        identity: { provider: "docker" as const, project: name, service: name },
        status: "running",
      })),
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: false,
      remediationEnabled: false,
    },
  };
}

function makeAlert(runnerId: string, service: string): NormalizedAlert {
  return {
    sourceAlertId: `alert-${randomUUID()}`,
    runnerId,
    targetIdentifier: { provider: "docker", project: service, service },
    alertType: "HighCPU",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
}

// Extracts what provider.start() was called with for the most recently created provider.
function captureStartMessage(): string | undefined {
  const idx = mockCreateProvider.mock.results.length - 1;
  // Vitest types mock.results[n].value as unknown; narrow to the actual mock shape.
  const provider = mockCreateProvider.mock.results[idx]?.value as
    | { start: ReturnType<typeof vi.fn> }
    | undefined;
  // mock.calls[n][m] is unknown; the first argument to start() is always the firstUserMessage string.
  return provider?.start.mock.calls[0]?.[0] as string | undefined;
}

describe("fleet summary injection", () => {
  let cleanupDb: () => void;
  let tokenIdA: string;
  let tokenIdB: string;

  beforeAll(() => {
    vi.stubEnv("SECRET_KEY", "test-only-secret-key-fleet-summary-tests-32b");
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    mockCreateProvider.mockClear();
    // Unregister all runners between tests so fleet state is clean.
    unregisterRunner(tokenIdA);
    if (tokenIdB) unregisterRunner(tokenIdB);
  });

  describe("multi-runner fleet", () => {
    beforeAll(() => {
      tokenIdA = generateRunnerToken("fleet-summary-a").id;
      tokenIdB = generateRunnerToken("fleet-summary-b").id;
    });

    it("first user message lists every server and its advertised services", async () => {
      registerRunner(
        tokenIdA,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdA,
        dockerManifest(tokenIdA, "web-01", ["nginx", "api"]),
      );

      registerRunner(
        tokenIdB,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdB,
        dockerManifest(tokenIdB, "db-02", ["postgres"]),
      );

      setScript([FINISH]);

      const sessionId = randomUUID();
      dispatcher.dispatch({ sessionId, alert: makeAlert(tokenIdA, "nginx") });
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // Both servers must appear in the fleet summary.
      expect(msg).toContain("web-01");
      expect(msg).toContain("db-02");

      // Services of each server must appear.
      expect(msg).toContain("nginx");
      expect(msg).toContain("api");
      expect(msg).toContain("postgres");
    });

    it("a neighbouring server's service identity appears so the agent can reference it", async () => {
      registerRunner(
        tokenIdA,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdA,
        dockerManifest(tokenIdA, "web-01", ["nginx"]),
      );

      registerRunner(
        tokenIdB,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdB,
        dockerManifest(tokenIdB, "cache-01", ["redis"]),
      );

      setScript([FINISH]);

      const sessionId = randomUUID();
      dispatcher.dispatch({ sessionId, alert: makeAlert(tokenIdA, "nginx") });
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // The alert is on web-01/nginx; redis on cache-01 is a NEIGHBOUR.
      // The fleet summary must expose it so the agent can reason about it.
      expect(msg).toContain("cache-01");
      expect(msg).toContain("redis");
    });

    it("does not send the raw capability manifest to the model", async () => {
      registerRunner(
        tokenIdA,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdA,
        dockerManifest(tokenIdA, "web-01", ["nginx"]),
      );

      registerRunner(
        tokenIdB,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdB,
        dockerManifest(tokenIdB, "db-02", ["postgres"]),
      );

      setScript([FINISH]);

      const sessionId = randomUUID();
      dispatcher.dispatch({ sessionId, alert: makeAlert(tokenIdA, "nginx") });
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // The capability manifest fields must NOT appear in the opening message.
      expect(msg).not.toContain("remediationEnabled");
      expect(msg).not.toContain("hostMetrics");
      expect(msg).not.toContain("fileRead");
      expect(msg).not.toContain("runnerVersion");
    });
  });

  describe("graceful degradation", () => {
    beforeAll(() => {
      tokenIdA = generateRunnerToken("fleet-summary-single").id;
    });

    it("single-runner fleet: no fleet summary section in first message", async () => {
      registerRunner(
        tokenIdA,
        () => {},
        () => {},
      );
      setRunnerManifest(
        tokenIdA,
        dockerManifest(tokenIdA, "web-01", ["nginx", "api"]),
      );

      setScript([FINISH]);

      const sessionId = randomUUID();
      dispatcher.dispatch({ sessionId, alert: makeAlert(tokenIdA, "nginx") });
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // A single-runner fleet has no neighbouring servers to reason about.
      // The fleet summary section must not appear.
      expect(msg).not.toContain("FLEET SUMMARY");
    });

    it("empty fleet (no connected runners): no fleet summary section", async () => {
      // No runners registered — tokenIdA has been unregistered by afterEach.
      setScript([FINISH]);

      const sessionId = randomUUID();
      dispatcher.dispatch({
        sessionId,
        alert: makeAlert("ghost-runner", "nginx"),
      });
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      expect(msg).not.toContain("FLEET SUMMARY");
    });
  });
});
