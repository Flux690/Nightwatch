import { describe, it, expect } from "vitest";

import type { Finding, Verdict } from "../reports.js";
import { principalFindings, rankFindings } from "../reports.js";

function claim(id: string, verdict: Verdict): Finding {
  return {
    id,
    statement: id,
    verdict,
    explanation: "",
    evidenceIds: [],
    recordedAt: "2026-08-19T02:14:00.000Z",
  };
}

/* The queue row and the report read this, so a second ranking anywhere is two
   answers to "what did the run conclude". */
describe("ranking what a run concluded", () => {
  it("returns every equally confident claim, most recent first", () => {
    const claims = [claim("f1", "root_cause"), claim("f2", "root_cause")];

    expect(principalFindings(claims).map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(rankFindings(claims).map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("keeps a lower-ranked standing claim out of the principal set", () => {
    const claims = [
      claim("f1", "root_cause"),
      claim("f2", "contributing_factor"),
    ];

    expect(principalFindings(claims).map((f) => f.id)).toEqual(["f1"]);
  });

  it("never leads with what the run ruled out or could not reach", () => {
    expect(
      principalFindings([claim("f1", "symptom"), claim("f2", "disproven")]).map(
        (f) => f.id,
      ),
    ).toEqual(["f1"]);
    expect(principalFindings([claim("f1", "disproven")])).toEqual([]);
    expect(principalFindings([claim("f1", "untestable")])).toEqual([]);
  });
});
