import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createContractFakeProvider,
  createGateController,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import type { NormalizedAlert, RunnerCommandMessage } from "@nightwatch/shared";
import Fastify from "fastify";
import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { respondToPendingHumanInput } from "../session/human-input.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  resolveCommand,
  unregisterRunner,
} from "../ws/router.js";

// Shared FIFO gate: every chat() parks until released, so an alert can be
// injected (or state asserted) while a run is parked mid-turn.
const gate = createGateController();

// Queue one provider per run, in order. A resume / leftover dispatch is a
// separate run, so chain one script per run (per-instance scriptIndex). All
// gated, so each chat() parks until releaseNext()/releaseAll().
function queueRuns(...scripts: ScriptedTurn[][]): void {
  for (const script of scripts) {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(script, { gate: gate.gate }),
    );
  }
}

// A free-form text finish: no tool call ends the run successfully.
const FINISH: ScriptedTurn = { toolUses: [], text: "Investigation complete." };

// Runner read tool — keeps the loop moving without introducing a human gate.
const READ: ScriptedTurn = {
  text: "",
  toolUses: [
    {
      id: "tu-read",
      name: "get_container_list",
      input: { environment: "docker" },
    },
  ],
};

// Alertmanager-shaped body for driving the real POST /alerts/ingest route.
function alertmanagerBody(fingerprint: string, severity = "warning") {
  return {
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPU", severity, container: "web-01" },
        annotations: { summary: "CPU high" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint,
      },
    ],
    version: "4",
    groupKey: "test",
    receiver: "nightwatch",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

function alert(tokenId: string, sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    runnerId: tokenId,
    targetIdentifier: "web-01",
    alertType: "HighCPU",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
}

describe("mid-run alert injection (loop seam)", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockCreateProvider.mockReset();
  });

  afterEach(async () => {
    gate.releaseAll();
    // Let any remaining microtasks / run finally-blocks settle before cleanup.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("alert injected mid-run appears in the next tool_results user message", async () => {
    const tokenId = generateToken("inject-midrun").id;
    registerRunner(
      tokenId,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [{ name: "web-01", status: "running" }],
        });
      },
      () => {},
    );

    // One run, two turns: runner read tool, then free-form finish.
    queueRuns([READ, FINISH]);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      alert: alert(tokenId, "primary-mr"),
    });

    // createProvider is called synchronously in start() before the first await.
    const provider = mockCreateProvider.mock.results[0]!.value as {
      appendToolResults: ReturnType<typeof vi.fn>;
    };

    // Inject while parked at turn 1's chat()
    dispatcher.injectAlert(sessionId, alert(tokenId, "injected-mr"));

    // Release turn 1 → loop executes get_container_list, drains inbox,
    // then calls appendToolResults(results, injectionText)
    gate.releaseNext();

    await waitFor(() => provider.appendToolResults.mock.calls.length > 0);

    const call = provider.appendToolResults.mock.calls[0] as [
      unknown,
      string | undefined,
    ];
    const additionalText = call[1];
    expect(additionalText).toBeDefined();
    expect(additionalText).toContain("injected-mr");

    // Release turn 2 and let the run finish cleanly.
    gate.releaseNext();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    unregisterRunner(tokenId);
  });

  it("an alert for a suspended session starts a new session instead of injecting", async () => {
    const tokenId = generateToken("inject-sus").id;

    // R1: gated tool → run suspends. R2 (new session): free-form finish.
    queueRuns(
      [
        {
          text: "",
          toolUses: [
            {
              id: "tu-gate",
              name: "restart_container",
              input: {
                containerName: "web-01",
                rationale: "test",
                risk: "low",
                estimatedDowntimeSeconds: 1,
              },
            },
          ],
        },
      ],
      [FINISH],
    );

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      alert: alert(tokenId, "primary-sus"),
    });

    // Release turn 1 → restart_container is gated → run suspends
    gate.releaseNext();
    await waitFor(() => hasPendingHumanInput(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // After suspension there is no active alert session operator-wide
    expect(dispatcher.getActiveAlertSession()).toBeNull();

    // Dispatching a new alert creates a new session (not injected into the suspended one)
    const callsBefore = mockCreateProvider.mock.calls.length;
    const newSessionId = randomUUID();

    dispatcher.dispatch({
      sessionId: newSessionId,
      alert: alert(tokenId, "new-after-sus"),
    });

    await waitFor(() => mockCreateProvider.mock.calls.length > callsBefore);

    // New session is running independently
    expect(dispatcher.isSessionRunning(newSessionId)).toBe(true);
    expect(dispatcher.getActiveAlertSession()).toBe(newSessionId);

    // The suspended session's inbox was not touched
    expect(dispatcher.drainInbox(sessionId)).toHaveLength(0);

    gate.releaseNext(); // free-form finish for the new session
    await waitFor(() => !dispatcher.isSessionRunning(newSessionId));
  });

  it("inbox leftovers when a run ends become new sessions", async () => {
    const tokenId = generateToken("inject-leftover").id;

    // R1: free-form finish immediately (loop exits before any appendToolResults,
    // so the inbox is never drained by the loop). R2: leftover's new session.
    queueRuns([FINISH], [FINISH]);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      alert: alert(tokenId, "primary-lo"),
    });

    // Inject before releasing — alert sits in inbox
    dispatcher.injectAlert(sessionId, alert(tokenId, "leftover-lo"));

    const callsBefore = mockCreateProvider.mock.calls.length;

    // Release: chat() resolves with free-form finish → run exits without draining inbox
    gate.releaseNext();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // The dispatcher's finally block dispatches leftovers as new sessions.
    // createProvider is called synchronously in the new session's start().
    await waitFor(() => mockCreateProvider.mock.calls.length > callsBefore, {
      timeout: 5_000,
    });

    const newProvider = mockCreateProvider.mock.results[
      mockCreateProvider.mock.calls.length - 1
    ]!.value as { start: ReturnType<typeof vi.fn> };
    const openingMsg = newProvider.start.mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(openingMsg).toBeDefined();

    // The leftover session's opening message is for the leftover alert
    gate.releaseNext(); // free-form finish for the leftover session
    await waitFor(() => dispatcher.getActiveAlertSession() === null);
  });

  // Regression for H3: a resume dispatch (human-input/service.ts) carries no
  // `alert` field, so the dispatcher must recover alert identity from the
  // session itself - otherwise the post-approval phase looks alert-free and
  // the real /alerts/ingest route misroutes correlated alerts into new
  // sessions instead of injecting them, and re-fires of the same alert are
  // no longer deduped.
  it("after approve-resume, a correlated alert injects into the resumed session and the original alert is deduped", async () => {
    const { id: tokenId, plaintext: tokenPlaintext } =
      generateToken("inject-resume");
    registerRunner(
      tokenId,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: { restarted: true },
        });
      },
      () => {},
    );

    // R1: gated tool → run suspends. R2 (resume): free-form finish.
    queueRuns(
      [
        {
          text: "Restarting.",
          toolUses: [
            {
              id: "tu-gate-resume",
              name: "restart_container",
              input: {
                containerName: "web-01",
                rationale: "test",
                risk: "low",
                estimatedDowntimeSeconds: 1,
              },
            },
          ],
        },
      ],
      [FINISH],
    );

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      alert: alert(tokenId, "primary-resume"),
    });

    gate.releaseNext();
    await waitFor(() => hasPendingHumanInput(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // Approve: the resume dispatch this issues carries no `alert` field.
    await respondToPendingHumanInput(sessionId, { decision: "approve" });
    await waitFor(() => dispatcher.isSessionRunning(sessionId));

    // The core H3 fix: the resumed session is still recognized as the active
    // alert investigation even though this dispatch carried no alert.
    expect(dispatcher.getActiveAlertSession()).toBe(sessionId);

    const server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();

    // A correlated alert from the same server, ingested through the real
    // route, must inject into the resumed session rather than spawn a new one.
    const correlated = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": tokenPlaintext },
      payload: alertmanagerBody("correlated-resume"),
    });
    expect(JSON.parse(correlated.body)).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
    expect(dispatcher.drainInbox(sessionId)).toHaveLength(1);

    // The same alert re-firing while the resumed run is active is deduped.
    const refire = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": tokenPlaintext },
      payload: alertmanagerBody("primary-resume"),
    });
    expect(JSON.parse(refire.body)).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });

    await server.close();
    gate.releaseNext(); // free-form finish for the resumed run
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    unregisterRunner(tokenId);
  });
});
