import { afterEach, vi } from "vitest";
import { logger } from "../logger.js";

// A dispatched investigation that throws is caught and logged by the dispatcher
// (so one bad run can't take down the server). That is correct in production but
// dangerous in tests: a swallowed run failure would let a broken test pass green
// - which is exactly how the seed-fidelity bug hid. Spy on the logger and fail
// the test if any run logged "investigation failed" while it ran. Background run
// failures must surface.
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
