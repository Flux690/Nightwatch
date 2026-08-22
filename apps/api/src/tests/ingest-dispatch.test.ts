import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { harness, type Harness } from "./harness.js";
import {
  createContractFakeProvider,
  createGateController,
  type ContractFakeProvider,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import { generateAlertSourceToken } from "../db/alert-sources.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import { dispatcher } from "../dispatcher.js";
import { updateConfig } from "../config/store.js";
import {
  appendErrorMessage,
  countInvestigations,
  getSession,
  listSessionSources,
  markAlertCleared,
  queueDepth,
  recordRunFailure,
} from "../db/sessions.js";
import { randomUUID } from "node:crypto";
import { waitFor } from "./wait.js";
import { seedAlertSession } from "./session-helper.js";
import { reconcileRecovery } from "../verification/reconciler.js";

// A free-form finish: no tool call ends the run successfully.
const FINISH: ScriptedTurn[] = [
  { toolUses: [], text: "Investigation complete." },
];

// Shared FIFO gate. In gated mode a run parks on chat() so it stays live long
// enough to assert against it; releaseAll() lets it finish.
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

interface AlertSpec {
  fingerprint: string;
  container?: string;
  startsAt?: string;
  status?: "firing" | "resolved";
}

/* One webhook delivery, which is one alert group. groupKey is what Alertmanager
   computed from the user's group_by, and it is the only thing that decides
   which alerts share an investigation - so every test names it explicitly. */
function delivery(groupKey: string, alerts: AlertSpec[], truncated = 0) {
  return {
    alerts: alerts.map((a) => ({
      status: a.status ?? "firing",
      labels: {
        alertname: "HighCPU",
        severity: "warning",
        container: a.container ?? "web-01",
      },
      annotations: { summary: "CPU high" },
      startsAt: a.startsAt ?? "2026-07-07T03:00:00.000Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: a.fingerprint,
    })),
    version: "4",
    groupKey,
    truncatedAlerts: truncated,
    receiver: "nightwarden",
    status: "firing",
    groupLabels: { alertname: "HighCPU" },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("POST /alerts/ingest: one delivery, one investigation", () => {
  let nw: Harness;
  let token: string;

  beforeAll(async () => {
    nw = await harness({
      routes: [registerAlertRoutes],
      runners: [{ name: "host-web-01", services: ["web-01"] }],
      listen: false,
    });
    token = generateAlertSourceToken("alertmanager");
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    // Drain parked runs so a later test never inherits a held seat. A released
    // finish re-parks while the finish gate nudges, so release repeatedly.
    await settle();
    gate.releaseAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    updateConfig({ maxConcurrentInvestigations: 10 });
  });

  function ingest(
    body: ReturnType<typeof delivery>,
  ): Promise<{ enqueued: number; skipped: number }> {
    return nw.server
      .inject({
        method: "POST",
        url: "/api/alerts/ingest",
        headers: { "x-nightwarden-token": token },
        payload: body,
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as { enqueued: number; skipped: number };
      });
  }

  function liveSessions(): string[] {
    return listSessionSources(100, 0, "investigation")
      .sources.map((s) => s.sessionId)
      .filter((id) => dispatcher.isSessionRunning(id));
  }

  function alertIdsOf(sessionId: string): string[] {
    return (getSession(sessionId)?.alerts ?? []).map(
      (entry) => entry.alert.sourceAlertId,
    );
  }

  // A released finish re-parks while the finish gate nudges for a record, so
  // one release is not the end of a run - keep releasing until nothing is live.
  async function settle(): Promise<void> {
    for (let i = 0; i < 40 && liveSessions().length > 0; i++) {
      gate.releaseAll();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  /* The governing rule, and the whole point of the fix: relatedness is the alert
     source's decision, so two groups are two incidents however close together
     they fire. Nothing here waits on a window, because there is no longer one. */
  it("two alerts in different groups, ten seconds apart, open two investigations", async () => {
    useGatedProvider();
    const before = countInvestigations();

    await ingest(delivery('{}:{alertname="Redis"}', [{ fingerprint: "r-1" }]));
    await waitFor(() => countInvestigations() === before + 1);

    await ingest(
      delivery('{}:{alertname="Payments"}', [
        { fingerprint: "p-1", container: "web-01" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 2);

    expect(liveSessions()).toHaveLength(2);
  });

  it("one delivery carrying three alerts opens one investigation covering all of them", async () => {
    useGatedProvider();
    const before = countInvestigations();

    const result = await ingest(
      delivery('{}:{alertname="Cascade"}', [
        { fingerprint: "c-1" },
        { fingerprint: "c-2" },
        { fingerprint: "c-3" },
      ]),
    );
    expect(result).toMatchObject({ enqueued: 3, skipped: 0 });

    await waitFor(() => countInvestigations() === before + 1);
    const [sessionId] = liveSessions();
    expect(alertIdsOf(sessionId!).sort()).toEqual(["c-1", "c-2", "c-3"]);
  });

  // Asserted through the opening turn, not the row: the count crosses four
  // layers and any one of them dropping it is the same defect.
  it("tells the agent how many alerts the sender left out of a delivery", async () => {
    useGatedProvider();
    const before = countInvestigations();

    await ingest(
      delivery('{}:{alertname="Withheld"}', [{ fingerprint: "wh-1" }], 6),
    );
    await waitFor(() => countInvestigations() === before + 1);

    const provider = mockCreateProvider.mock.results.at(-1)
      ?.value as ContractFakeProvider;
    await waitFor(() => provider.start.mock.calls.length > 0);
    expect(provider.start.mock.calls[0]?.[0]).toContain(
      "left 6 further alerts out of this delivery",
    );
  });

  it("a new alert in a group already being investigated joins that run", async () => {
    useGatedProvider();
    const groupKey = '{}:{alertname="Joining"}';
    const before = countInvestigations();

    await ingest(delivery(groupKey, [{ fingerprint: "j-1" }]));
    await waitFor(() => countInvestigations() === before + 1);
    const [sessionId] = liveSessions();

    await ingest(delivery(groupKey, [{ fingerprint: "j-2" }]));

    // Same investigation, now covering both: no second row, and the alert is on
    // the session so resolution waits for it too.
    expect(countInvestigations()).toBe(before + 1);
    expect(alertIdsOf(sessionId!).sort()).toEqual(["j-1", "j-2"]);
  });

  /* Alertmanager repeats a still-firing alert on repeat_interval, as often as
     every few minutes. Scoped to the run rather than the alert, this would open
     a fresh investigation of the identical alert every time one finished. */
  it("a repeat of the same alert is dropped even after its investigation ended", async () => {
    useImmediateProvider();
    const groupKey = '{}:{alertname="Repeating"}';
    const spec = { fingerprint: "rep-1", startsAt: "2026-07-07T03:00:00.000Z" };
    const before = countInvestigations();

    await ingest(delivery(groupKey, [spec]));
    await waitFor(() => countInvestigations() === before + 1);
    await waitFor(() => liveSessions().length === 0);

    const repeat = await ingest(delivery(groupKey, [spec]));
    expect(repeat).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(countInvestigations()).toBe(before + 1);
  });

  it("the same alert firing again after it cleared is a new incident", async () => {
    useImmediateProvider();
    const groupKey = '{}:{alertname="Flapping"}';
    const before = countInvestigations();

    await ingest(
      delivery(groupKey, [
        { fingerprint: "f-1", startsAt: "2026-07-07T03:00:00.000Z" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 1);
    await waitFor(() => liveSessions().length === 0);
    markAlertCleared("f-1", new Date().toISOString());

    // A different startsAt is a different incident, which is what the pairing of
    // fingerprint and fired-at is for.
    await ingest(
      delivery(groupKey, [
        { fingerprint: "f-1", startsAt: "2026-07-07T09:00:00.000Z" },
      ]),
    );
    await waitFor(() => countInvestigations() === before + 2);
  });

  /* A repeat no longer re-triggers a broken run, so the recovery sweep is what
     tries again. Seeded rather than driven to failure: what is under test is
     which failures earn another attempt. */
  function failedInvestigation(fingerprint: string): string {
    const sessionId = randomUUID();
    seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [
        {
          sourceAlertId: fingerprint,
          labels: {},
          alertType: "HighCPU",
          severity: "warning",
          firedAt: "2026-07-07T03:00:00.000Z",
          annotations: {},
          generatorURL: null,
          values: {},
          rawPayload: {},
        },
      ],
    );
    appendErrorMessage(sessionId, "The provider had a server problem.");
    return sessionId;
  }

  describe("a run that failed while its alert kept firing", () => {
    it("is retried when the cause was worth waiting out", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-1");
      recordRunFailure(sessionId, "transient");

      const pass = await reconcileRecovery(Date.now() + 3_600_000);
      expect(pass.retried).toBe(1);
      await settle();
    });

    it("stops after three attempts, however long the incident runs", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-capped");
      // Three failures with nothing in between: the count is what is spent, not
      // the elapsed time, so no amount of further sweeping earns a fourth.
      for (let i = 0; i < 3; i++) recordRunFailure(sessionId, "transient");

      const pass = await reconcileRecovery(Date.now() + 3_600_000);
      expect(pass.retried).toBe(0);
    });

    it("is never retried when trying again cannot work", async () => {
      useGatedProvider();
      const sessionId = failedInvestigation("retry-2");

      // A rejected key, an empty account, a model that does not exist: each
      // fails identically every time, so retrying only writes more failures.
      recordRunFailure(sessionId, "permanent");
      const pass = await reconcileRecovery(Date.now() + 3_600_000);
      expect(pass.retried).toBe(0);
    });
  });

  describe("when every seat is taken", () => {
    it("queues the delivery rather than dropping what it already answered 200", async () => {
      useGatedProvider();
      updateConfig({ maxConcurrentInvestigations: 1 });
      const before = countInvestigations();

      await ingest(
        delivery('{}:{alertname="First"}', [{ fingerprint: "q-1" }]),
      );
      await waitFor(() => countInvestigations() === before + 1);

      const queued = await ingest(
        delivery('{}:{alertname="Second"}', [{ fingerprint: "q-2" }]),
      );
      // Accepted, not skipped: the sender was told 200 and has nobody to retry to.
      expect(queued).toMatchObject({ enqueued: 1, skipped: 0 });
      expect(countInvestigations()).toBe(before + 1);
      expect(queueDepth().waiting).toBe(1);

      // A seat frees, and the alert that was waiting becomes an investigation of
      // its own rather than joining the one that just ended.
      await settle();
      await waitFor(() => countInvestigations() === before + 2);
      expect(queueDepth().waiting).toBe(0);
    });

    it("never investigates an alert that recovered while it waited", async () => {
      useGatedProvider();
      updateConfig({ maxConcurrentInvestigations: 1 });
      const before = countInvestigations();

      await ingest(
        delivery('{}:{alertname="Holder"}', [{ fingerprint: "w-1" }]),
      );
      await waitFor(() => countInvestigations() === before + 1);
      await ingest(
        delivery('{}:{alertname="Waiter"}', [{ fingerprint: "w-2" }]),
      );
      expect(queueDepth().waiting).toBe(1);

      // The resolved notification lands while it is still queued.
      markAlertCleared("w-2", new Date().toISOString());
      expect(queueDepth().waiting).toBe(0);

      await settle();
      // No session was opened to report on a condition that was already over.
      expect(countInvestigations()).toBe(before + 1);
    });
  });
});
