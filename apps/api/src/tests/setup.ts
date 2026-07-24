import { afterEach, vi } from "vitest";
import { logger } from "../logger.js";

// Tests never run the boot sequence that resolves SECRET_KEY, and they must not
// depend on the developer's .env - a fixed test key keeps the suite hermetic.
process.env["SECRET_KEY"] = "nightwarden-test-secret-key";

// A dispatched investigation that throws is caught and logged (correct in production, but a
// swallowed failure would pass green in tests) - fail the test if any run logs it instead.
const errorSpy = vi.spyOn(logger, "error");

let expectingFailure = false;

// Failure-path tests declare the "investigation failed" log as intended;
// everywhere else it still fails the test.
export function expectInvestigationFailure(): void {
  expectingFailure = true;
}

afterEach(() => {
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
