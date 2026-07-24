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
import {
  createContractFakeProvider,
  createGateController,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import { generateAlertSourceToken } from "../db/alert-sources.js";
import { useTempDb } from "./temp-db.js";
import { seedCompleteReport } from "./report-helper.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import { dispatcher } from "../dispatcher.js";
import {
  markRunnerAlive,
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { dockerService, manifest } from "./manifest-helper.js";

// A free-form finish: no tool call ends the run successfully.
const FINISH: ScriptedTurn[] = [
  { toolUses: [], text: "Investigation complete." },
];

// Shared FIFO gate. In gated mode a run parks on chat() so it stays "active"
// long enough to assert derived dedup against it; releaseAll() lets it finish.
const gate = createGateController();

function useGatedProvider(): void {
  mockCreateProvider.mockImplementation(() =>
    createContractFakeProvider(FINISH, { gate: gate.gate }),
  );
}

function useImmediateProvider(): void {
  mockCreateProvider.mockImplementation(() =>
    createContractFakeProvider(FINISH),
  );
}

// One firing alert with a caller-chosen fingerprint (sourceAlertId) and severity, so dedup and
// rate-limit drive precisely; container defaults to web-01 but each test can pick its own.
function alertBody(
  fingerprint: string,
  severity = "warning",
  container = "web-01",
  startsAt = new Date().toISOString(),
) {
  return {
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPU", severity, container },
        annotations: { summary: "CPU high" },
        startsAt,
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint,
      },
    ],
    version: "4",
    groupKey: "test",
    receiver: "nightwarden",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("POST /alerts/ingest dispatch behavior", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let connA: RunnerConnection;
  let connB: RunnerConnection;

  // Two runners advertising distinct services keep the fleet non-empty for
  // ingest and give the mixed-batch test a matched and an unmatched identity.
  beforeAll(async () => {
    cleanupDb = useTempDb();
    connA = registerRunner(
      "dispatch-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "dispatch-runner-a-token",
      manifest("host-web-01", [dockerService("web-01")]),
    );
    connB = registerRunner(
      "dispatch-runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "dispatch-runner-b-token",
      manifest("host-web-02", [dockerService("web-02")]),
    );
    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner(connA);
    unregisterRunner(connB);
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    // Drain any parked runs so a later test never inherits a held dedup key.
    // Released reportless finishes re-park while the finish gate nudges, so
    // release repeatedly until every straggler has finalized and completed.
    vi.useRealTimers();
    for (let i = 0; i < 6 && dispatcher.getActiveAlertSession() !== null; i++) {
      gate.releaseAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    gate.releaseAll();
  });

  function ingest(
    token: string,
    body: ReturnType<typeof alertBody>,
  ): Promise<{ enqueued: number; skipped: number }> {
    return server
      .inject({
        method: "POST",
        url: "/alerts/ingest",
        headers: { "x-nightwarden-token": token },
        payload: body,
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as { enqueued: number; skipped: number };
      });
  }

  it("drops a duplicate alert while its run is active, then re-investigates after it ends", async () => {
    const token = generateAlertSourceToken("dedup");
    // A re-notification carries the SAME startsAt - that pairing is the dedup key.
    const firedAt = "2026-07-07T03:00:00.000Z";
    // Fake only setTimeout/clearTimeout for the batch window. Fastify's internal
    // setImmediate is NOT faked, so inject() continues to work correctly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useGatedProvider(); // runs park on the gate -> stay active

    const first = await ingest(
      token,
      alertBody("dup-1", "warning", "web-01", firedAt),
    );
    expect(first).toMatchObject({ enqueued: 1, skipped: 0 });

    // advanceTimersByTimeAsync flushes the microtask queue at each step, which is required
    // since waitFor itself uses setTimeout.
    await vi.advanceTimersByTimeAsync(90_001);
    expect(dispatcher.isInvestigating("dup-1", firedAt)).toBe(true);

    // Same fingerprint + startsAt while the first run is still active -> dropped.
    const dupe = await ingest(
      token,
      alertBody("dup-1", "warning", "web-01", firedAt),
    );
    expect(dupe).toMatchObject({ enqueued: 0, skipped: 1 });

    // A twin incident - same fingerprint, its own startsAt - is NOT a duplicate.
    const twin = await ingest(
      token,
      alertBody("dup-1", "warning", "web-01", "2026-07-07T03:09:00.000Z"),
    );
    expect(twin).toMatchObject({ enqueued: 1, skipped: 0 });

    // End the active run; a seeded report satisfies the finish gate so the
    // released free-form finish completes it, and the dedup key clears.
    seedCompleteReport(dispatcher.getActiveAlertSession()!);
    gate.releaseAll();
    await vi.advanceTimersByTimeAsync(50);
    expect(dispatcher.isInvestigating("dup-1", firedAt)).toBe(false);

    // The same alert now starts a fresh investigation - no 24h suppression.
    const refire = await ingest(
      token,
      alertBody("dup-1", "warning", "web-01", firedAt),
    );
    expect(refire).toMatchObject({ enqueued: 1, skipped: 0 });
    // Advance the refire's batch window so no stray timer outlives this test;
    // it parks on the gate and is drained by afterEach.
    await vi.advanceTimersByTimeAsync(90_001);
  });

  it("rate-limits past 30 non-critical alerts fleet-wide per hour; critical bypasses; resets after the window", async () => {
    const token = generateAlertSourceToken("ratelimit");
    useImmediateProvider(); // runs complete at once; rate-limit is independent of them
    // Fake only Date - the rate-limit window is Date.now()-based. Faking
    // setImmediate/setTimeout too would hang Fastify's async internals.
    vi.useFakeTimers({ toFake: ["Date"] });

    // The counter is global module state; jump past any window earlier tests
    // opened so this test counts from zero.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    markRunnerAlive(connA);
    markRunnerAlive(connB);

    // 30 distinct alerts all admitted.
    for (let i = 0; i < 30; i++) {
      const r = await ingest(token, alertBody(`rl-${i}`, "warning", "web-02"));
      expect(r).toMatchObject({ enqueued: 1, skipped: 0 });
    }

    // The 31st non-critical alert is rate-limited.
    expect(
      await ingest(token, alertBody("rl-over", "warning", "web-02")),
    ).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });

    // A critical alert bypasses the limit even while it is exhausted.
    expect(
      await ingest(token, alertBody("rl-crit", "critical", "web-02")),
    ).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });

    // Jumping the fake clock also pushes the runner's liveness past its TTL, so refresh it -
    // a real runner would still be answering pings.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    markRunnerAlive(connB);
    expect(
      await ingest(token, alertBody("rl-after", "warning", "web-02")),
    ).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
  });

  it("dispatches matched and unmatched alerts alike - no identity gate at ingest", async () => {
    const token = generateAlertSourceToken("mixed-batch");
    useImmediateProvider();

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwarden-token": token },
      payload: {
        alerts: [
          {
            status: "firing",
            labels: {
              alertname: "HighCPU",
              severity: "warning",
              container: "web-01",
            },
            annotations: { summary: "CPU high" },
            startsAt: new Date().toISOString(),
            endsAt: "0001-01-01T00:00:00Z",
            fingerprint: "mixed-match",
          },
          {
            status: "firing",
            labels: {
              alertname: "HighCPU",
              severity: "warning",
              container: "ghost-service",
            },
            annotations: { summary: "CPU high" },
            startsAt: new Date().toISOString(),
            endsAt: "0001-01-01T00:00:00Z",
            fingerprint: "mixed-no-match",
          },
        ],
        version: "4",
        groupKey: "test",
        receiver: "nightwarden",
        status: "firing",
        groupLabels: {},
        commonLabels: {},
        commonAnnotations: {},
        externalURL: "http://localhost:9093",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      received: number;
      enqueued: number;
      skipped: number;
    };
    expect(body.received).toBe(2);
    expect(body.enqueued).toBe(2);
    expect(body.skipped).toBe(0);
  });
});
