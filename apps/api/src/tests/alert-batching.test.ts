import "dotenv/config";
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
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// Same provider mock pattern as ingest-dispatch.test.ts: chat() parks by default
// (so we can observe mid-window state), immediate mode makes runs finish quickly.
const { mockCreateProvider, releaseAll, setRunImmediate } = vi.hoisted(() => {
  const FINAL = {
    id: "fr-1",
    name: "final_response",
    input: {
      rootCause: {
        summary: "done",
        evidence: ["e"],
        contributingFactors: null,
      },
      recommendedAction: null,
      escalateIfRejected: false,
      investigationSteps: ["s"],
    },
  };
  let immediate = true;
  const gates: Array<() => void> = [];
  const finalTurn = {
    stopReason: "tool_use" as const,
    toolUses: [FINAL],
    text: "",
  };
  const make = () => ({
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn((): unknown[] => []),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
    chat: vi.fn(() => {
      if (immediate) return Promise.resolve(finalTurn);
      return new Promise<typeof finalTurn>((resolve) => {
        gates.push(() => resolve(finalTurn));
      });
    }),
  });
  return {
    mockCreateProvider: vi.fn(make),
    releaseAll: (): void => {
      const copy = [...gates];
      gates.length = 0;
      for (const g of copy) g();
    },
    setRunImmediate: (v: boolean): void => {
      immediate = v;
    },
  };
});

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { registerAlertRoutes } from "../alerts/ingest.js";

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

describe("alert batching (REST seam + fake timers)", () => {
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

  beforeEach(() => {
    mockCreateProvider.mockClear();
    setRunImmediate(true);
  });

  afterEach(() => {
    releaseAll();
    vi.useRealTimers();
  });

  async function ingest(
    token: string,
    body: ReturnType<typeof alertBody>,
  ): Promise<{ enqueued: number; skipped: number }> {
    const res = await server.inject({
      method: "POST",
      url: "/alerts/ingest",
      headers: { "x-nightwatch-token": token },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { enqueued: number; skipped: number };
  }

  it("three same-token alerts within 90s produce one session whose opening message contains all three; none are dropped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { plaintext: token } = mintToken("batch-three");

    const r1 = await ingest(token, alertBody("fp-1"));
    const r2 = await ingest(token, alertBody("fp-2"));
    const r3 = await ingest(token, alertBody("fp-3"));

    // All three accepted — none dropped
    expect(r1).toMatchObject({ enqueued: 1, skipped: 0 });
    expect(r2).toMatchObject({ enqueued: 1, skipped: 0 });
    expect(r3).toMatchObject({ enqueued: 1, skipped: 0 });

    // Batch window is holding — no session started yet
    expect(mockCreateProvider.mock.calls).toHaveLength(0);

    // Fire the 90s window
    vi.advanceTimersByTime(90_001);

    // Exactly one session (all three collapsed into one)
    expect(mockCreateProvider.mock.calls).toHaveLength(1);

    const firstProvider = mockCreateProvider.mock.results[0]!.value as {
      start: ReturnType<typeof vi.fn>;
    };
    const openingMsg = firstProvider.start.mock.calls[0]![0] as string;
    expect(openingMsg).toContain("fp-1");
    expect(openingMsg).toContain("fp-2");
    expect(openingMsg).toContain("fp-3");
  });

  it("alerts for different tokens do not batch together", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { plaintext: tokenA } = mintToken("batch-tok-a");
    const { plaintext: tokenB } = mintToken("batch-tok-b");

    // Two for tokenA, one for tokenB
    await ingest(tokenA, alertBody("fp-a1"));
    await ingest(tokenB, alertBody("fp-b1"));
    await ingest(tokenA, alertBody("fp-a2"));

    expect(mockCreateProvider.mock.calls).toHaveLength(0);

    vi.advanceTimersByTime(90_001);

    // Two sessions — one per token
    expect(mockCreateProvider.mock.calls).toHaveLength(2);

    const openingMsgs = mockCreateProvider.mock.results.map((r) => {
      const p = r.value as { start: ReturnType<typeof vi.fn> };
      return p.start.mock.calls[0]![0] as string;
    });

    const msgA = openingMsgs.find(
      (m) => m.includes("fp-a1") && m.includes("fp-a2"),
    )!;
    expect(msgA).toBeDefined();
    expect(msgA).not.toContain("fp-b1");

    const msgB = openingMsgs.find((m) => m.includes("fp-b1"))!;
    expect(msgB).toBeDefined();
    expect(msgB).not.toContain("fp-a1");
    expect(msgB).not.toContain("fp-a2");
  });

  it("dedup drops true duplicates (same sourceAlertId) within the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { plaintext: token } = mintToken("batch-dedup");

    // First occurrence
    const r1 = await ingest(token, alertBody("dup-fp"));
    expect(r1).toMatchObject({ enqueued: 1, skipped: 0 });

    // Same fingerprint again — true duplicate, should be dropped
    const r2 = await ingest(token, alertBody("dup-fp"));
    expect(r2).toMatchObject({ enqueued: 0, skipped: 1 });

    // Different fingerprint — joins the batch
    const r3 = await ingest(token, alertBody("other-fp"));
    expect(r3).toMatchObject({ enqueued: 1, skipped: 0 });

    vi.advanceTimersByTime(90_001);

    // One session, opening message has both fingerprints (not the duplicate)
    expect(mockCreateProvider.mock.calls).toHaveLength(1);
    const p = mockCreateProvider.mock.results[0]!.value as {
      start: ReturnType<typeof vi.fn>;
    };
    const openingMsg = p.start.mock.calls[0]![0] as string;
    expect(openingMsg).toContain("dup-fp");
    expect(openingMsg).toContain("other-fp");
  });
});
