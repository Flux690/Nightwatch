import { randomUUID } from "node:crypto";
import { dispatchAlertSession } from "./session-helper.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { initSecrets } from "../secrets.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateRunnerToken } from "../fleet/runners-store.js";

// The two servers this file connects, named once so keys and addresses agree.
const SERVER_A = "web-01";
const SERVER_B = "db-02";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import type { RunnerConnection } from "../fleet/connections.js";
import { dispatcher } from "../dispatcher.js";
import type { RunnerManifest, NormalizedAlert } from "@nightwarden/shared";
import { dockerService, manifest } from "./manifest-helper.js";

const FINISH: ScriptedTurn = { toolUses: [], text: "Investigation complete." };

function dockerManifest(
  server: string,
  serviceNames: string[],
): RunnerManifest {
  return manifest(
    `${server}.internal`,
    serviceNames.map((name) => dockerService(server, name)),
  );
}

function makeAlert(service: string): NormalizedAlert {
  return {
    sourceAlertId: `alert-${randomUUID()}`,
    // The labels are the whole record of what the alert named; the Compose pair
    // is what the manifest fixtures below advertise.
    labels: {
      alertname: "HighCPU",
      "com.docker.compose.project": service,
      "com.docker.compose.service": service,
    },
    alertType: "HighCPU",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

// Extracts what provider.start() was called with for the most recently created provider.
function captureStartMessage(): string | undefined {
  const idx = mockCreateProvider.mock.results.length - 1;
  // Vitest types mock.results[n].value as unknown; narrow to the actual mock shape.
  const provider = mockCreateProvider.mock.results[idx]?.value as
    { start: ReturnType<typeof vi.fn> } | undefined;
  // mock.calls[n][m] is unknown; the first argument to start() is always the firstUserMessage string.
  return provider?.start.mock.calls[0]?.[0] as string | undefined;
}

describe("fleet summary injection", () => {
  let cleanupDb: () => void;
  let runnerIdA: string;
  let runnerIdB: string;
  let connA: RunnerConnection | undefined;
  let connB: RunnerConnection | undefined;

  beforeAll(async () => {
    vi.stubEnv(
      "NIGHTWARDEN_SECRET_KEY",
      "test-only-secret-key-fleet-summary-tests-32b",
    );
    initSecrets();
    cleanupDb = await useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    mockCreateProvider.mockClear();
    // Unregister all runners between tests so fleet state is clean.
    if (connA) {
      unregisterRunner(connA);
      connA = undefined;
    }
    if (connB) {
      unregisterRunner(connB);
      connB = undefined;
    }
  });

  describe("multi-runner fleet", () => {
    beforeAll(async () => {
      runnerIdA = (await generateRunnerToken("docker", SERVER_A)).id;
      runnerIdB = (await generateRunnerToken("docker", SERVER_B)).id;
    });

    it("first user message lists every server and its advertised services", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx", "api"]));

      connB = registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        serverName: SERVER_B,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdB, dockerManifest(SERVER_B, ["postgres"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

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

    it("gives the same service on two servers two distinct keys, and marks neither", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx", "api"]));

      connB = registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        serverName: SERVER_B,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdB, dockerManifest(SERVER_B, ["nginx"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      const msg = captureStartMessage();

      // Each key names its own server, so the summary marks neither and no call
      // needs a second argument to say which machine it means.
      expect(msg).toContain(`${SERVER_A}/nginx/nginx`);
      expect(msg).toContain(`${SERVER_B}/nginx/nginx`);
      expect(msg).not.toContain("(shared)");
    });

    // The platform is stated once per server line, not in every key.
    it("names each server's platform on its own line", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      expect(captureStartMessage()).toContain(`${SERVER_A} (Docker host):`);
    });

    it("a neighbouring server's service identity appears so the agent can reference it", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx"]));

      connB = registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        serverName: SERVER_B,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdB, dockerManifest(SERVER_B, ["redis"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // The alert is on SERVER_A/nginx; redis on SERVER_B is a NEIGHBOUR.
      // The fleet summary must expose it so the agent can reason about it.
      expect(msg).toContain(SERVER_B);
      expect(msg).toContain("redis");
    });

    it("does not send the raw capability manifest to the model", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx"]));

      connB = registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        serverName: SERVER_B,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdB, dockerManifest(SERVER_B, ["postgres"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // The capability manifest fields must NOT appear in the opening message.
      expect(msg).not.toContain("hostMetrics");
      expect(msg).not.toContain("fileRead");
      expect(msg).not.toContain("runnerVersion");
    });
  });

  describe("graceful degradation", () => {
    beforeAll(async () => {
      runnerIdA = (await generateRunnerToken("docker", SERVER_A)).id;
    });

    it("single-runner fleet: fleet summary still lists the one server", async () => {
      connA = registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: SERVER_A,
        send: () => {},
        close: () => {},
      });
      setRunnerManifest(runnerIdA, dockerManifest(SERVER_A, ["nginx", "api"]));

      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      // The map carries the addressable server name the required `server`
      // parameter needs - it must appear even with a single server.
      expect(msg).toContain("<fleet-summary>");
      expect(msg).toContain("web-01");
    });

    it("empty fleet (no connected runners): no fleet summary section", async () => {
      // No runners registered — runnerIdA has been unregistered by afterEach.
      setScript([FINISH]);

      const sessionId = randomUUID();
      await dispatchAlertSession(sessionId, [makeAlert("nginx")]);
      await waitFor(
        async () => !(await dispatcher.isSessionRunning(sessionId)),
      );

      const msg = captureStartMessage();
      expect(msg).toBeDefined();

      expect(msg).not.toContain("<fleet-summary>");
    });
  });
});
