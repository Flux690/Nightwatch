import { afterEach, vi } from "vitest";
import { logger } from "../logger.js";

// Tests never run the boot sequence that resolves SECRET_KEY, and they must not
// depend on the developer's .env - a fixed test key keeps the suite hermetic.
process.env["SECRET_KEY"] = "nightwatch-test-secret-key";

// A dispatched investigation that throws is caught and logged (correct in production,
// dangerous in tests: a swallowed failure passes green - how the seed-fidelity bug hid).
// Spy on the logger and fail the test if any run logged "investigation failed".
const errorSpy = vi.spyOn(logger, "error");

afterEach(() => {
  const failure = errorSpy.mock.calls.find((args) =>
    args.includes("investigation failed"),
  );
  errorSpy.mockClear();
  if (failure) {
    throw new Error(
      'A dispatched investigation failed during this test (logger.error "investigation failed"). ' +
        "Background run failures must surface, not be swallowed - check the fake provider's fidelity " +
        "(seed must restore the transcript) and the resume path.",
    );
  }
});
