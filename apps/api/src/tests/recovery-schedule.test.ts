import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { reconcileRecovery } from "../verification/reconciler.js";
import { seedAlertSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

/* The sweep thins out as an incident ages. Too dense and it hammers the metrics
   source during the incident; too thin and a recovery is never confirmed. Its
   own file because `asked` is a count over every open session, so the cadence
   can only be read in a database holding one. */
describe("how often an open condition is asked about", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => cleanupDb());

  const MINUTE = 60_000;

  // One session watching one uncleared alert, aged by choosing when it opened.
  function watching(sourceAlertId: string, openedAt: number): void {
    seedAlertSession(
      {
        sessionId: randomUUID(),
        title: "t",
        createdAt: new Date(openedAt).toISOString(),
      },
      [
        {
          sourceAlertId,
          labels: {},
          annotations: {},
          alertType: "HighMemory",
          severity: "warning",
          firedAt: new Date(openedAt).toISOString(),
          generatorURL: null,
          values: {},
          rawPayload: {},
        },
      ],
    );
  }

  const asksAt = async (at: number): Promise<number> =>
    (await reconcileRecovery(at)).asked;

  it("asks about once a minute while the incident is fresh", async () => {
    const opened = Date.now();
    watching("cadence-fresh", opened);

    expect(await asksAt(opened)).toBe(1);
    expect(await asksAt(opened + 30_000)).toBe(0);
    expect(await asksAt(opened + 61_000)).toBe(1);
  });

  it("thins to every five minutes once it is no longer fresh", async () => {
    const opened = Date.now();
    await asksAt(opened + 20 * MINUTE);

    expect(await asksAt(opened + 22 * MINUTE)).toBe(0);
    expect(await asksAt(opened + 26 * MINUTE)).toBe(1);
  });

  /* Past a day nobody is watching this run, and the sender's resolved webhook
     still answers instantly if the condition ever does clear. */
  it("stops asking after a day", async () => {
    const opened = Date.now();

    expect(await asksAt(opened + 25 * 60 * MINUTE)).toBe(0);
  });
});
