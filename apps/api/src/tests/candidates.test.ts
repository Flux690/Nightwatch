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
import { createContractFakeProvider } from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import type { NormalizedAlert } from "@nightwarden/shared";
import type { ProviderMessage } from "../llm/types.js";
import { runSession, buildSessionMeta } from "../agent/loop/run-session.js";
import { getRecord } from "../session/record-store.js";
import { openCandidateIds } from "../agent/report.js";
import { buildTranscript } from "../session/transcript.js";
import { seedAlertSession } from "./session-helper.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import { resolveCommand } from "../fleet/transport.js";
import { generateRunnerToken } from "../fleet/runners-store.js";
import { manifest } from "./manifest-helper.js";
import { useTempDb } from "./temp-db.js";

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighLatency",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

describe("candidates, the frontier and falsification", () => {
  async function connectRunner() {
    const runnerId = (await generateRunnerToken("docker", "cand-host")).id;
    const conn = registerRunner({
      runnerId,
      platform: "docker",
      serverName: "cand-host",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as { payload: { correlationId: string } };
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      close: () => {},
    });
    setRunnerManifest(runnerId, manifest("cand-host"));
    return conn;
  }

  let cleanupDb: () => void;
  let runner: ReturnType<typeof registerRunner>;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
  });
  afterAll(() => cleanupDb());
  beforeEach(async () => {
    mockCreateProvider.mockReset();
    runner = await connectRunner();
  });
  afterEach(() => unregisterRunner(runner));

  const readTurn = () => ({
    toolUses: [
      {
        toolCallId: `tu-read-${randomUUID()}`,
        name: "ListDockerServices",
        input: { server: ["cand-host"] },
      },
    ],
    text: "",
  });

  const openTurn = (
    candidates: Array<{
      statement: string;
      ifTrue: string;
      ifFalse: string;
      parent?: string;
    }>,
  ) => ({
    toolUses: [
      {
        toolCallId: `tu-open-${randomUUID()}`,
        name: "OpenCandidates",
        input: { candidates },
      },
    ],
    text: "",
  });

  const findingTurn = (
    verdict: string,
    statement: string,
    extra: { settles?: string; supersedes?: string } = {},
  ) => ({
    toolUses: [
      {
        toolCallId: `tu-find-${randomUUID()}`,
        name: "RecordFinding",
        input: {
          statement,
          verdict,
          explanation: "what the read showed",
          evidenceIds: ["e1"],
          ...extra,
        },
      },
    ],
    text: "",
  });

  const stopTurn = { toolUses: [], text: "Done." };
  const submitTurn = {
    toolUses: [
      {
        toolCallId: "tu-submit",
        name: "ComposeReport",
        input: {
          headline: "checkout slowed under a saturated pool",
          affected: "the checkout path",
          summary: "the pool was exhausted",
          timeline: [],
          impact: "a few minutes of slow checkouts",
          recommendation: "raise the pool ceiling",
        },
      },
    ],
    text: "",
  };

  const POOL = {
    statement: "the connection pool was exhausted",
    ifTrue: "pool_in_use pinned at its ceiling across the slowdown",
    ifFalse: "pool_in_use had headroom during the slowdown",
  };
  const PG = {
    statement: "postgres was slow",
    ifTrue: "query p99 climbed with the alert",
    ifFalse: "query p99 stayed flat across the window",
  };

  function harnessMessages(index = 0): string[] {
    const provider = mockCreateProvider.mock.results[index]!.value as {
      chat: ReturnType<typeof vi.fn>;
    };
    const calls = provider.chat.mock.calls as Array<[ProviderMessage[]]>;
    const opening = calls[0]?.[0]?.length ?? 0;
    return (calls.at(-1)?.[0] ?? [])
      .slice(opening)
      .filter(
        (m) => m.role === "user" && m.parts.every((p) => p.type === "text"),
      )
      .map((m) => m.content);
  }

  async function start(id: string): Promise<void> {
    await seedAlertSession(buildSessionMeta(id, null, undefined), [alert(id)]);
    await runSession({ sessionId: id, alerts: [alert(id)] });
  }

  it("forces candidates after the first read, and keeps the open ones in view", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        findingTurn("root_cause", POOL.statement, { settles: "c1" }),
        findingTurn("disproven", PG.statement, { settles: "c2" }),
        stopTurn,
        stopTurn,
        submitTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const record = (await getRecord(id))!;
    expect(record.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(record.findings.map((f) => f.settles)).toEqual(["c1", "c2"]);
    expect(openCandidateIds(record)).toEqual([]);
    expect(record.report).not.toBeNull();

    // The frontier speaks each time the open set changes: both open, then c2 alone.
    const frontier = harnessMessages().filter((m) => m.includes("Still open:"));
    expect(frontier.length).toBeGreaterThanOrEqual(2);
    expect(frontier[0]).toContain("c1");
    expect(frontier[0]).toContain("c2");
  });

  it("pushes back when a candidate is left untested", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        findingTurn("root_cause", POOL.statement, { settles: "c1" }),
        stopTurn,
        findingTurn("disproven", PG.statement, { settles: "c2" }),
        stopTurn,
        stopTurn,
        submitTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const pushed = harnessMessages().filter((m) =>
      m.includes("candidates you have not settled"),
    );
    expect(pushed).toHaveLength(1);
    expect((await getRecord(id))!.report).not.toBeNull();
  });

  it("draws the candidate board in the transcript and folds the record tools into it", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        findingTurn("root_cause", POOL.statement, { settles: "c1" }),
        findingTurn("disproven", PG.statement, { settles: "c2" }),
        stopTurn,
        stopTurn,
        submitTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const items = await buildTranscript(id);
    const board = items.find((i) => i.kind === "candidate_card");
    if (board === undefined || board.kind !== "candidate_card") {
      throw new Error("no candidate board in the transcript");
    }
    expect(board.rows.map((r) => [r.statement, r.state])).toEqual([
      [POOL.statement, "root_cause"],
      [PG.statement, "disproven"],
    ]);
    // The record tools fold into the board rather than printing their own rows.
    const toolNames = items.flatMap((i) =>
      i.kind === "tool_call" ? [i.toolName] : [],
    );
    expect(toolNames).not.toContain("OpenCandidates");
    expect(toolNames).not.toContain("RecordFinding");
  });

  it("runs a falsification turn naming every candidate before the report", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL, PG]),
        findingTurn("root_cause", POOL.statement, { settles: "c1" }),
        findingTurn("disproven", PG.statement, { settles: "c2" }),
        stopTurn,
        stopTurn,
        submitTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    const table = harnessMessages().find((m) =>
      m.includes("test your own conclusions"),
    );
    expect(table).toBeDefined();
    expect(table).toContain("c1");
    expect(table).toContain("c2");
    expect(table).toContain("would disprove");
  });

  it("reopens a candidate when a later finding supersedes the one that settled it", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        readTurn(),
        openTurn([POOL]),
        findingTurn("trigger", POOL.statement, { settles: "c1" }),
        findingTurn("disproven", "the pool reading predated the slowdown", {
          supersedes: "f1",
        }),
        stopTurn,
        findingTurn("root_cause", POOL.statement, { settles: "c1" }),
        stopTurn,
        stopTurn,
        submitTurn,
      ]),
    );
    const id = randomUUID();
    await start(id);

    // The superseding finding withdrew c1's answer, so the gate asked for it again.
    const pushed = harnessMessages().filter((m) =>
      m.includes("candidates you have not settled"),
    );
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const record = (await getRecord(id))!;
    expect(openCandidateIds(record)).toEqual([]);
    expect(record.findings).toHaveLength(3);
  });
});
