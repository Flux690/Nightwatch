import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { openDb } from "../db.js";
import { logger } from "../logger.js";
import { initSecrets } from "../secrets.js";
import { deriveStatus } from "../session/status-store.js";

/* Suite-wide, before anything can open a database: a test that reaches getDb
   without its own useTempDb would otherwise create one in the developer's real
   ~/.nightwarden. Structural, so remembering it is not a per-file duty. */
process.env["NIGHTWARDEN_DIR"] = mkdtempSync(join(tmpdir(), "nw-suite-"));

// A fixed key keeps the suite off the developer's .env, and the suite runs the
// same boot step production does rather than reaching past it.
process.env["NIGHTWARDEN_SECRET_KEY"] = "nightwarden-test-secret-key";
initSecrets();

// A dispatched investigation that throws is caught and logged (correct in production, but a
// swallowed failure would pass green in tests) - fail the test if any run logs it instead.
const errorSpy = vi.spyOn(logger, "error");
const infoSpy = vi.spyOn(logger, "info");

let expectingFailure = false;
let expectingDuplicate = false;

// Failure-path tests declare the "investigation failed" log as intended;
// everywhere else it still fails the test.
export function expectInvestigationFailure(): void {
  expectingFailure = true;
}

// Dedup tests declare the drop; everywhere else it means a fingerprint and
// startsAt this file already used, so the investigation never opened.
export function expectDuplicateAlert(): void {
  expectingDuplicate = true;
}

/* A stored status that a fresh derivation disagrees with means a transition
   wrote its column and forgot to refresh. `running` is exempt: it is claimed by
   a process rather than derived, so no stored row can confirm it. */
async function assertStatusesDerivable(): Promise<void> {
  // openDb, not getDb: a test file with no database of its own must not have
  // one created for it here.
  const db = openDb();
  if (db === undefined) return;
  const rows = await db
    .selectFrom("sessions")
    .select(["session_id as sessionId", "status"])
    .where("status", "!=", "running")
    .execute();
  for (const row of rows) {
    const derived = await deriveStatus(row.sessionId);
    if (derived !== row.status) {
      throw new Error(
        `Session ${row.sessionId} is stored as "${row.status}" but derives to ` +
          `"${derived}". Whatever changed it must call refreshSessionStatus.`,
      );
    }
  }
}

afterEach(async () => {
  await assertStatusesDerivable();
  const dropped = infoSpy.mock.calls.some((args) =>
    args.includes("duplicate alerts dropped"),
  );
  const wantedDrop = expectingDuplicate;
  expectingDuplicate = false;
  infoSpy.mockClear();
  if (dropped && !wantedDrop) {
    throw new Error(
      "An alert was dropped as a duplicate during this test. Dedup matches on " +
        "fingerprint plus startsAt, so another case in this file used both - " +
        "give this one its own, or call expectDuplicateAlert() if the drop is the point.",
    );
  }
  if (wantedDrop && !dropped) {
    throw new Error(
      "expectDuplicateAlert() was called but no alert was dropped as a duplicate",
    );
  }
  const failure = errorSpy.mock.calls.find((args) =>
    args.includes("investigation failed"),
  );
  const expected = expectingFailure;
  expectingFailure = false;
  errorSpy.mockClear();
  if (expected) {
    if (!failure) {
      throw new Error(
        "expectInvestigationFailure() was called but no dispatched run failed",
      );
    }
    return;
  }
  if (failure) {
    throw new Error(
      'A dispatched investigation failed during this test (logger.error "investigation failed"). ' +
        "Background run failures must surface, not be swallowed - check the fake provider's fidelity " +
        "(seed must restore the transcript) and the resume path.",
    );
  }
});
