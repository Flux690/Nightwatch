import { afterEach, vi } from "vitest";
import { openDb } from "../db.js";
import { logger } from "../logger.js";
import { initSecrets } from "../secrets.js";
import { deriveStatus } from "../session/status.js";

// A fixed key keeps the suite off the developer's .env, and the suite runs the
// same boot step production does rather than reaching past it.
process.env["NIGHTWARDEN_SECRET_KEY"] = "nightwarden-test-secret-key";
initSecrets();

// A dispatched investigation that throws is caught and logged (correct in production, but a
// swallowed failure would pass green in tests) - fail the test if any run logs it instead.
const errorSpy = vi.spyOn(logger, "error");

let expectingFailure = false;

// Failure-path tests declare the "investigation failed" log as intended;
// everywhere else it still fails the test.
export function expectInvestigationFailure(): void {
  expectingFailure = true;
}

/* A stored status that a fresh derivation disagrees with means a transition
   wrote its column and forgot to refresh. `running` is exempt: it is claimed by
   a process rather than derived, so no stored row can confirm it. */
function assertStatusesDerivable(): void {
  // openDb, not getDb: a test file with no database of its own must not have
  // one created for it here.
  const db = openDb();
  if (db === undefined) return;
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, status FROM sessions
        WHERE status <> 'running'`,
    )
    .all() as Array<{ sessionId: string; status: string }>;
  for (const row of rows) {
    const derived = deriveStatus(row.sessionId);
    if (derived !== row.status) {
      throw new Error(
        `Session ${row.sessionId} is stored as "${row.status}" but derives to ` +
          `"${derived}". Whatever changed it must call refreshSessionStatus.`,
      );
    }
  }
}

afterEach(() => {
  assertStatusesDerivable();
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
