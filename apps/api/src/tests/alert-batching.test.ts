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
import {
  createContractFakeProvider,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
import { dockerService, manifest } from "./manifest-helper.js";

// Every alertBody() below carries the `container: "web-01"` label (anonymous
// Docker fallback), so one connected runner advertising that exact identity
// is enough for every alert in this file to resolve (ADR-0004).
const WEB_01_MANIFEST = manifest("runner-web-01", "host-web-01", [
  dockerService("web-01"),
]);

// A free-form finish: no tool call ends the run successfully and immediately.
const FINISH: ScriptedTurn[] = [
  { toolUses: [], text: "Investigation complete." },
];

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
    registerRunner(
      "batching-runner-token",
      () => {},
      () => {},
    );
    setRunnerManifest("batching-runner-token", WEB_01_MANIFEST);
    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner("batching-runner-token");
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockCreateProvider.mockReset();
    mockCreateProvider.mockImplementation(() =>
      createContractFakeProvider(FINISH),
    );
  });

  afterEach(() => {
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
    const { plaintext: token } = generateRunnerToken("batch-three");

    const r1 = await ingest(token, alertBody("fp-1"));
    const r2 = await ingest(token, alertBody("fp-2"));
    const r3 = await ingest(token, alertBody("fp-3"));

    expect(r1).toMatchObject({ enqueued: 1, skipped: 0 });
    expect(r2).toMatchObject({ enqueued: 1, skipped: 0 });
    expect(r3).toMatchObject({ enqueued: 1, skipped: 0 });

    expect(mockCreateProvider.mock.calls).toHaveLength(0);

    vi.advanceTimersByTime(90_001);

    expect(mockCreateProvider.mock.calls).toHaveLength(1);

    const firstProvider = mockCreateProvider.mock.results[0]!.value as {
      start: ReturnType<typeof vi.fn>;
    };
    const openingMsg = firstProvider.start.mock.calls[0]![0] as string;
    expect(openingMsg).toContain("fp-1");
    expect(openingMsg).toContain("fp-2");
    expect(openingMsg).toContain("fp-3");
  });

  it("alerts from different tokens batch into one operator-wide session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { plaintext: tokenA } = generateRunnerToken("batch-tok-a");
    const { plaintext: tokenB } = generateRunnerToken("batch-tok-b");

    await ingest(tokenA, alertBody("fp-a1"));
    await ingest(tokenB, alertBody("fp-b1"));
    await ingest(tokenA, alertBody("fp-a2"));

    expect(mockCreateProvider.mock.calls).toHaveLength(0);

    vi.advanceTimersByTime(90_001);

    expect(mockCreateProvider.mock.calls).toHaveLength(1);

    const openingMsg = (
      mockCreateProvider.mock.results[0]!.value as {
        start: ReturnType<typeof vi.fn>;
      }
    ).start.mock.calls[0]![0] as string;

    expect(openingMsg).toContain("fp-a1");
    expect(openingMsg).toContain("fp-a2");
    expect(openingMsg).toContain("fp-b1");
  });

  it("dedup drops true duplicates (same sourceAlertId) within the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { plaintext: token } = generateRunnerToken("batch-dedup");

    const r1 = await ingest(token, alertBody("dup-fp"));
    expect(r1).toMatchObject({ enqueued: 1, skipped: 0 });

    const r2 = await ingest(token, alertBody("dup-fp"));
    expect(r2).toMatchObject({ enqueued: 0, skipped: 1 });

    const r3 = await ingest(token, alertBody("other-fp"));
    expect(r3).toMatchObject({ enqueued: 1, skipped: 0 });

    vi.advanceTimersByTime(90_001);

    expect(mockCreateProvider.mock.calls).toHaveLength(1);
    const p = mockCreateProvider.mock.results[0]!.value as {
      start: ReturnType<typeof vi.fn>;
    };
    const openingMsg = p.start.mock.calls[0]![0] as string;
    expect(openingMsg).toContain("dup-fp");
    expect(openingMsg).toContain("other-fp");
  });
});
