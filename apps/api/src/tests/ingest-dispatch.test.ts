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

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import { dispatcher } from "../dispatcher.js";

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

// One firing Alertmanager alert with a caller-chosen fingerprint (-> sourceAlertId)
// and severity, so dedup and rate-limit can be driven precisely.
function alertBody(fingerprint: string, severity = "warning") {
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

describe("POST /alerts/ingest dispatch behavior", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
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
    // A fresh token isolates this test's rate-limit counter from the others.
    const { plaintext: token, id: tokenId } = generateToken("dedup");
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
    expect(dispatcher.isInvestigating(tokenId, "dup-1")).toBe(true);

    // Same token + sourceAlertId while the first run is still active -> dropped.
    const dupe = await ingest(token, alertBody("dup-1"));
    expect(dupe).toMatchObject({ enqueued: 0, skipped: 1 });

    // End the active run; flush the async chain so the dedup key clears.
    gate.releaseAll();
    await vi.advanceTimersByTimeAsync(50);
    expect(dispatcher.isInvestigating(tokenId, "dup-1")).toBe(false);

    // The same alert now starts a fresh investigation - no 24h suppression.
    const refire = await ingest(token, alertBody("dup-1"));
    expect(refire).toMatchObject({ enqueued: 1, skipped: 0 });
    // Advance the refire's batch window so no stray timer outlives this test;
    // it parks on the gate and is drained by afterEach.
    await vi.advanceTimersByTimeAsync(90_001);
  });

  it("rate-limits past 10 non-critical alerts per runner per hour; critical bypasses; resets after the window", async () => {
    const { plaintext: token } = generateToken("ratelimit");
    useImmediateProvider(); // runs complete at once; rate-limit is independent of them
    // Fake only Date - the rate-limit window is Date.now()-based. Faking
    // setImmediate/setTimeout too would hang Fastify's async internals.
    vi.useFakeTimers({ toFake: ["Date"] });

    // 10 distinct alerts all admitted.
    for (let i = 0; i < 10; i++) {
      const r = await ingest(token, alertBody(`rl-${i}`));
      expect(r).toMatchObject({ enqueued: 1, skipped: 0 });
    }

    // The 11th non-critical alert is rate-limited.
    expect(await ingest(token, alertBody("rl-over"))).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });

    // A critical alert bypasses the limit even while it is exhausted.
    expect(await ingest(token, alertBody("rl-crit", "critical"))).toMatchObject(
      {
        enqueued: 1,
        skipped: 0,
      },
    );

    // After the hourly window the counter resets and non-critical flows again.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(await ingest(token, alertBody("rl-after"))).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
  });
});
