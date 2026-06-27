import "dotenv/config";
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

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import { dispatcher } from "../dispatcher.js";
import {
  recordHeartbeat,
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
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

// One firing alert with a caller-chosen fingerprint (sourceAlertId) and severity, so dedup
// and rate-limit drive precisely. container defaults to web-01 but each test picks its own
// so they resolve to distinct runnerIds.
function alertBody(
  fingerprint: string,
  severity = "warning",
  container = "web-01",
) {
  return {
    alerts: [
      {
        status: "firing",
        labels: { alertname: "HighCPU", severity, container },
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

describe("POST /alerts/ingest dispatch behavior", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  // Rate-limit and dedup are keyed by runnerId, so these two tests need alerts resolving to
  // different runners - else they share the per-runner counter. Two container labels on two
  // runners give two runnerIds (ADR-0004), the isolation two tokens used to give for free.
  beforeAll(async () => {
    cleanupDb = useTempDb();
    registerRunner(
      "dispatch-runner-a-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "dispatch-runner-a-token",
      manifest("runner-web-01", "host-web-01", [dockerService("web-01")]),
    );
    registerRunner(
      "dispatch-runner-b-token",
      () => {},
      () => {},
    );
    setRunnerManifest(
      "dispatch-runner-b-token",
      manifest("runner-web-02", "host-web-02", [dockerService("web-02")]),
    );
    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner("dispatch-runner-a-token");
    unregisterRunner("dispatch-runner-b-token");
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    // Drain any parked runs so a later test never inherits a held dedup key.
    gate.releaseAll();
    vi.useRealTimers();
  });

  function ingest(
    token: string,
    body: ReturnType<typeof alertBody>,
  ): Promise<{ enqueued: number; skipped: number }> {
    return server
      .inject({
        method: "POST",
        url: "/alerts/ingest",
        headers: { "x-nightwatch-token": token },
        payload: body,
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as { enqueued: number; skipped: number };
      });
  }

  it("drops a duplicate alert while its run is active, then re-investigates after it ends", async () => {
    // This test's alerts target web-01 -> resolve to runner-web-01; dedup is
    // keyed by that runnerId now, not by the authenticating token (ADR-0004).
    const { plaintext: token } = generateRunnerToken("dedup");
    // Fake only setTimeout/clearTimeout for the batch window. Fastify's internal
    // setImmediate is NOT faked, so inject() continues to work correctly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useGatedProvider(); // runs park on the gate -> stay active

    const first = await ingest(token, alertBody("dup-1"));
    expect(first).toMatchObject({ enqueued: 1, skipped: 0 });

    // Fire the batch window timer (90s) and flush any resulting promises so the
    // run starts and parks. advanceTimersByTimeAsync flushes the microtask queue
    // at each step, which is required since waitFor itself uses setTimeout.
    await vi.advanceTimersByTimeAsync(90_001);
    expect(dispatcher.isInvestigating("runner-web-01", "dup-1")).toBe(true);

    // Same token + sourceAlertId while the first run is still active -> dropped.
    const dupe = await ingest(token, alertBody("dup-1"));
    expect(dupe).toMatchObject({ enqueued: 0, skipped: 1 });

    // End the active run; flush the async chain so the dedup key clears.
    gate.releaseAll();
    await vi.advanceTimersByTimeAsync(50);
    expect(dispatcher.isInvestigating("runner-web-01", "dup-1")).toBe(false);

    // The same alert now starts a fresh investigation - no 24h suppression.
    const refire = await ingest(token, alertBody("dup-1"));
    expect(refire).toMatchObject({ enqueued: 1, skipped: 0 });
    // Advance the refire's batch window so no stray timer outlives this test;
    // it parks on the gate and is drained by afterEach.
    await vi.advanceTimersByTimeAsync(90_001);
  });

  it("rate-limits past 10 non-critical alerts per runner per hour; critical bypasses; resets after the window", async () => {
    const { plaintext: token } = generateRunnerToken("ratelimit");
    useImmediateProvider(); // runs complete at once; rate-limit is independent of them
    // Fake only Date - the rate-limit window is Date.now()-based. Faking
    // setImmediate/setTimeout too would hang Fastify's async internals.
    vi.useFakeTimers({ toFake: ["Date"] });

    // 10 distinct alerts all admitted.
    for (let i = 0; i < 10; i++) {
      const r = await ingest(token, alertBody(`rl-${i}`, "warning", "web-02"));
      expect(r).toMatchObject({ enqueued: 1, skipped: 0 });
    }

    // The 11th non-critical alert is rate-limited.
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

    // After the hourly window the counter resets and non-critical flows again. Jumping the fake
    // clock also pushes the runner's heartbeat past its TTL, so refresh it - a real runner would
    // have kept heartbeating.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    recordHeartbeat("dispatch-runner-b-token");
    expect(
      await ingest(token, alertBody("rl-after", "warning", "web-02")),
    ).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
  });

  it("dispatches the matched alert and reports the unmatched one in rejected, neither suppressing the other", async () => {
    const { plaintext: token } = generateRunnerToken("mixed-batch");
    useImmediateProvider();

    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": token },
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
        receiver: "nightwatch",
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
      rejected: Array<{ sourceAlertId: string; reason: string }>;
    };
    expect(body.received).toBe(2);
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.sourceAlertId).toBe("mixed-no-match");
    expect(body.rejected[0]!.reason).toMatch(/no runner advertises/i);
  });
});
