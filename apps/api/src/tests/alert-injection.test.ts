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

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import type {
  NormalizedAlert,
  RunnerCommandMessage,
} from "@nightwarden/shared";
import Fastify from "fastify";
import { generateRunnerToken } from "../db/runner.js";
import { generateAlertSourceToken } from "../db/alert-sources.js";
import { useTempDb } from "./temp-db.js";
import { seedCompleteReport, seedRecommendation } from "./report-helper.js";
import { dispatchAlertSession, WHOLE_DELIVERY } from "./session-helper.js";
import { routeDelivery } from "../alerts/route-alert.js";
import {
  countInvestigations,
  listSessionSources,
  sessionCoveringGroup,
} from "../db/sessions.js";
import { waitFor } from "./wait.js";
import { dispatcher } from "../dispatcher.js";
import {
  getPendingHumanInputBySessionId,
  hasPendingHumanInput,
} from "../db/interrupts.js";
import { isDuplicate } from "../alerts/dedup.js";
import { findToolCall, getSession } from "../db/sessions.js";
import { buildTranscript } from "../session/transcript.js";
import { respondToPendingHumanInput } from "../session/human-input.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { dockerService, manifest } from "./manifest-helper.js";
import { mountApi } from "./api-server.js";

// Matches the container:"web-01" label alertmanagerBody() carries.
function webOneManifest() {
  return manifest("host-inject-resume", [dockerService("web-01")]);
}

// Shared FIFO gate: every chat() parks until released, so an alert can be
// injected (or state asserted) while a run is parked mid-turn.
const gate = createGateController();

// One per scenario: a session covering a group is exactly what a later alert in
// it should join, so a shared key makes one test capture the next test's alerts.
const MIDRUN_GROUP = '{}:{alertname="MidRun"}';
const SUSPENDED_GROUP = '{}:{alertname="Suspended"}';
const RESUME_GROUP = '{}:{alertname="Resume"}';
const OTHER_GROUP = '{}:{alertname="Unrelated"}';

// Every run this file starts has to be drained before the next test, or a
// parked provider script is inherited by a run that did not queue it.
function nothingRunning(): boolean {
  return !listSessionSources(100, 0, "investigation").sources.some((s) =>
    dispatcher.isSessionRunning(s.sessionId),
  );
}

// Queue one provider per run, in order - a resume/leftover dispatch is a separate run,
// so chain one script per run. All gated, so each chat() parks until released.
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
      name: "ListDockerServices",
      input: {},
    },
  ],
};

// Alertmanager-shaped body for driving the real POST /alerts/ingest route.
function alertmanagerBody(
  fingerprint: string,
  groupKey: string,
  severity = "warning",
  startsAt = new Date().toISOString(),
) {
  return {
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPU", severity, container: "web-01" },
        annotations: { summary: "CPU high" },
        startsAt,
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint,
      },
    ],
    version: "4",
    groupKey,
    receiver: "nightwarden",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

function alert(sourceAlertId: string, firedAt?: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighCPU",
    severity: "warning",
    firedAt: firedAt ?? new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
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

  it("alert injected mid-run reaches the model as its own turn, unseen by the user", async () => {
    const runnerId = generateRunnerToken("docker", "inject-midrun").id;
    const conn = registerRunner({
      runnerId: runnerId,
      platform: "docker",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [{ name: "web-01", status: "running" }],
        });
      },
      close: () => {},
    });

    // One run, two turns: runner read tool, then free-form finish.
    queueRuns([READ, FINISH]);

    const sessionId = randomUUID();
    dispatchAlertSession(sessionId, [alert("primary-mr")], MIDRUN_GROUP);
    // Injection mechanics only: a seeded report satisfies the finish gate. It
    // is a child of the session, and dispatch() creates that row synchronously.
    seedCompleteReport(sessionId);

    // createProvider is called synchronously in start() before the first await.
    const provider = mockCreateProvider.mock.results[0]!.value as {
      appendUserMessage: ReturnType<typeof vi.fn>;
    };

    // Inject while parked at turn 1's chat()
    dispatcher.injectAlert(
      sessionId,
      MIDRUN_GROUP,
      alert("injected-mr"),
      WHOLE_DELIVERY,
    );

    // Release turn 1 -> loop executes ListDockerServices, appends the results,
    // drains the inbox and sends the alert as its own turn.
    gate.releaseNext();

    await waitFor(() => provider.appendUserMessage.mock.calls.length > 0);

    const [injection] = provider.appendUserMessage.mock.calls[0] as [string];
    expect(injection).toContain("injected-mr");

    // Release turn 2 and every turn after it: the free-form finish is followed
    // by the report turn, which parks on this gate like any other.
    await gate.releaseUntil(() => !dispatcher.isSessionRunning(sessionId));

    // The alert is on the session's own row, and the user sees it as an
    // alert marking where the ground moved - not as prose they appear to have
    // written. The instruction sent to the model is drawn for nobody.
    expect(
      getSession(sessionId)?.alerts.map((a) => a.alert.sourceAlertId),
    ).toEqual(["primary-mr", "injected-mr"]);

    const transcript = buildTranscript(sessionId);
    expect(JSON.stringify(transcript)).not.toContain(
      "Another alert in this same alert group",
    );
    // Where the alert actually landed: it arrived while the model was still
    // composing turn 1, so the tool call that ran afterwards reads afterwards.
    expect(transcript.slice(0, 3).map((i) => i.kind)).toEqual([
      "alert_arrived",
      "tool_call",
      "agent_text",
    ]);
    unregisterRunner(conn);
  });

  it("an alert in the same group joins a suspended session; another group opens its own", async () => {
    const runnerId = generateRunnerToken("docker", "inject-sus").id;
    // connection with a synced cache is required, mirroring ws/server.ts's reconciliation.
    const susConn = registerRunner({
      runnerId: runnerId,
      platform: "docker",
      send: () => {},
      close: () => {},
    });

    // R1: gated tool → run suspends. R2 (new session): free-form finish.
    queueRuns(
      [
        {
          text: "",
          toolUses: [
            {
              id: "tu-gate",
              name: "RestartDockerService",
              input: {
                target: "docker/web-01/web-01",
                reason: "test",
                risk: "low",
                estimatedDowntimeSeconds: 1,
              },
            },
          ],
        },
      ],
      [FINISH],
    );

    const firedAtOfSuspended = new Date().toISOString();
    const sessionId = randomUUID();
    dispatchAlertSession(
      sessionId,
      [alert("primary-sus", firedAtOfSuspended)],
      SUSPENDED_GROUP,
    );

    // Release turn 1 → RestartDockerService is gated → run suspends
    gate.releaseNext();
    await waitFor(() => hasPendingHumanInput(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // The interrupt points at the gated call; the transcript row written in the
    // same transaction is what says which tool it was and with what arguments.
    const pending = getPendingHumanInputBySessionId(sessionId)!;
    const call = findToolCall(sessionId, pending.toolUseId)!;
    expect(call.name).toBe("RestartDockerService");
    expect(call.input).toMatchObject({
      target: "docker/web-01/web-01",
      reason: "test",
    });

    // A run nobody is watching still owns its alert, so the same alert firing
    // again must not open a second session for it.
    expect(isDuplicate(alert("primary-sus", firedAtOfSuspended))).toBe(true);

    // Suspended is still covering: parked on a person, not finished. The alert
    // rides along rather than opening a second investigation of one group.
    const before = countInvestigations();
    routeDelivery(
      SUSPENDED_GROUP,
      [alert("same-group-while-suspended")],
      WHOLE_DELIVERY,
    );
    expect(countInvestigations()).toBe(before);
    expect(
      dispatcher.drainInbox(sessionId).map((a) => a.sourceAlertId),
    ).toEqual(["same-group-while-suspended"]);

    // A different group is a different incident, whatever this session is doing.
    routeDelivery(
      OTHER_GROUP,
      [alert("other-group-while-suspended")],
      WHOLE_DELIVERY,
    );
    await waitFor(() => countInvestigations() === before + 1);

    // Drain every run this test started, or the next one inherits a parked
    // provider script and never gets its own.
    await gate.releaseUntil(() => nothingRunning());
    unregisterRunner(susConn);
  });

  // A resume dispatch carries no `alert` field, so the dispatcher must recover alert identity
  // from the session itself, or correlated alerts misroute into new sessions and re-fires go undeduped.
  it("after approve-resume, a correlated alert injects into the resumed session and the original alert is deduped", async () => {
    const runnerId = generateRunnerToken("docker", "inject-resume").id;
    const tokenPlaintext = generateAlertSourceToken("alertmanager");
    const conn = registerRunner({
      runnerId: runnerId,
      platform: "docker",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: { restarted: true },
        });
      },
      close: () => {},
    });
    setRunnerManifest(runnerId, webOneManifest());
    // Sync the DB mode into the connection cache, as reconciliation would.

    // R1: gated tool → run suspends. R2 (resume): free-form finish.
    queueRuns(
      [
        {
          text: "Restarting.",
          toolUses: [
            {
              id: "tu-gate-resume",
              name: "RestartDockerService",
              input: {
                target: "docker/web-01/web-01",
                reason: "test",
                risk: "low",
                estimatedDowntimeSeconds: 1,
              },
            },
          ],
        },
      ],
      [FINISH],
    );

    const primaryFiredAt = "2026-07-07T03:00:00.000Z";
    const sessionId = randomUUID();
    dispatchAlertSession(
      sessionId,
      [alert("primary-resume", primaryFiredAt)],
      RESUME_GROUP,
    );
    seedCompleteReport(sessionId);
    // This run restarts a service, and a run that changed something owes the
    // user a recommendation - otherwise the finish gate asks for one.
    seedRecommendation(sessionId, "restart web-01");

    gate.releaseNext();
    await waitFor(() => hasPendingHumanInput(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // Approve: the resume dispatch this issues carries no `alert` field.
    await respondToPendingHumanInput(sessionId, { decision: "approve" });
    await waitFor(() => dispatcher.isSessionRunning(sessionId));

    // The resumed session is still the one covering this group, even though the
    // resume dispatch carried no alerts of its own.
    expect(sessionCoveringGroup(RESUME_GROUP)).toBe(sessionId);

    const server = Fastify({ logger: false });
    await mountApi(server, registerAlertRoutes);
    await server.ready();

    // A correlated alert from the same server, ingested through the real
    // route, must inject into the resumed session rather than spawn a new one.
    const correlated = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": tokenPlaintext },
      payload: alertmanagerBody("correlated-resume", RESUME_GROUP),
    });
    expect(JSON.parse(correlated.body)).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
    expect(dispatcher.drainInbox(sessionId)).toHaveLength(1);

    // The same alert re-firing (same fingerprint + startsAt) while the
    // resumed run is active is deduped.
    const refire = await server.inject({
      method: "POST",
      url: "/api/alerts/ingest",
      headers: { "x-nightwarden-token": tokenPlaintext },
      payload: alertmanagerBody(
        "primary-resume",
        RESUME_GROUP,
        "warning",
        primaryFiredAt,
      ),
    });
    expect(JSON.parse(refire.body)).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });

    await server.close();
    await gate.releaseUntil(() => !dispatcher.isSessionRunning(sessionId));
    unregisterRunner(conn);
  });
});
