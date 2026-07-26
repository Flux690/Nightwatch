import { describe, expect, it } from "vitest";
import { describeNetworkFailure } from "../integrations/reachability.js";

// Node wraps connection failures this way; the code is the only reliable signal.
function fetchFailure(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe("describeNetworkFailure", () => {
  it("separates a name that will not resolve from a port with nothing on it", () => {
    const dns = describeNetworkFailure(fetchFailure("ENOTFOUND"), "Prometheus");
    const refused = describeNetworkFailure(
      fetchFailure("ECONNREFUSED"),
      "Prometheus",
    );

    expect(dns).toMatch(/resolve/i);
    expect(refused).toMatch(/nothing is listening/i);
    expect(dns).not.toEqual(refused);
  });

  it("always says where the attempt came from, which the browser cannot show", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "NOPE"]) {
      expect(describeNetworkFailure(fetchFailure(code), "Loki")).toMatch(
        /from the NightWarden API/i,
      );
    }
  });

  it("names a certificate problem rather than reporting it as unreachable", () => {
    expect(
      describeNetworkFailure(fetchFailure("CERT_HAS_EXPIRED"), "Loki"),
    ).toMatch(/certificate has expired/i);
  });

  it("falls back to a plain message for a code it does not know", () => {
    expect(describeNetworkFailure(fetchFailure("EWEIRD"), "Loki")).toMatch(
      /could not reach loki/i,
    );
  });
});
