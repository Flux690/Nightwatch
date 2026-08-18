import { describe, it, expect } from "vitest";

import type { Hypothesis, Verdict } from "../reports.js";
import { leadingHypothesis, rankHypotheses } from "../reports.js";

function claim(id: string, verdict: Verdict): Hypothesis {
  return {
    id,
    statement: id,
    verdict,
    finding: "",
    evidenceIds: [],
    recordedAt: "2026-08-19T02:14:00.000Z",
  };
}

/* The queue row and the report read this, so a second ranking anywhere is two
   answers to "what did the run conclude". */
describe("ranking what a run concluded", () => {
  it("leads with the last recorded of two equally confident claims", () => {
    const claims = [claim("h1", "root_cause"), claim("h2", "root_cause")];

    expect(leadingHypothesis(claims)?.id).toBe("h2");
    expect(rankHypotheses(claims).map((h) => h.id)).toEqual(["h2", "h1"]);
  });

  it("never leads with what the run ruled out", () => {
    const claims = [claim("h1", "symptom"), claim("h2", "disproven")];

    expect(leadingHypothesis(claims)?.id).toBe("h1");
    expect(leadingHypothesis([claim("h1", "disproven")])).toBeNull();
  });
});
