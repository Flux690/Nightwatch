import { describe, expect, it } from "vitest";
import { parseAlertmanager } from "../alerts/parsers/alertmanager.js";

// Covers the parser's own job: projecting fields, normalizing severity, isolating malformed
// alerts. Identity derivation is exercised separately in service-identity.test.ts.

function alert(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "firing",
    labels: { alertname: "HighCPU", severity: "warning", container: "web-01" },
    annotations: {},
    startsAt: "2026-06-21T10:00:00Z",
    fingerprint: "fp-1",
    ...overrides,
  };
}

describe("parseAlertmanager", () => {
  it("projects an alert's fields into the normalized shape", () => {
    const [parsed] = parseAlertmanager({ alerts: [alert()] }).firing;
    expect(parsed).toMatchObject({
      sourceAlertId: "fp-1",
      alertType: "HighCPU",
      severity: "warning",
      firedAt: "2026-06-21T10:00:00Z",
    });
    // The labels are the whole record of what the alert named; nothing is derived
    // from them at parse time, so no speculative identity is ever stored.
    expect(parsed?.labels).toMatchObject({ alertname: "HighCPU" });
  });

  // Calling an unrecognized word "info" would state a severity nobody wrote.
  it("normalizes the conventional words and leaves anything else unknown", () => {
    const sev = (s: string | undefined) =>
      parseAlertmanager({
        alerts: [alert({ labels: { alertname: "X", severity: s } })],
      }).firing[0]?.severity;
    expect(sev("error")).toBe("critical");
    expect(sev("critical")).toBe("critical");
    expect(sev("warn")).toBe("warning");
    expect(sev("info")).toBe("info");
    expect(sev("page")).toBeNull();
    expect(sev("P1")).toBeNull();
    expect(sev(undefined)).toBeNull();
  });

  // The word survives verbatim even when the normalized rank cannot read it.
  it("keeps the severity label verbatim whatever it normalizes to", () => {
    const [parsed] = parseAlertmanager({
      alerts: [alert({ labels: { alertname: "X", severity: "P1" } })],
    }).firing;
    expect(parsed?.labels["severity"]).toBe("P1");
    expect(parsed?.severity).toBeNull();
  });

  it("throws only when the envelope itself is not an alerts array", () => {
    expect(() => parseAlertmanager({})).toThrow(/missing alerts array/);
    expect(() => parseAlertmanager({ alerts: "nope" })).toThrow(
      /missing alerts array/,
    );
  });

  describe("batch independence", () => {
    it("a malformed alert is skipped without aborting routable siblings", () => {
      const { firing } = parseAlertmanager({
        alerts: [
          alert({ fingerprint: "good-1" }),
          // labels:null used to throw on labels["alertname"] and lose the batch
          { status: "firing", labels: null, fingerprint: "bad-1" },
          "not-an-object",
          alert({ fingerprint: "good-2" }),
        ],
      });
      const ids = firing.map((p) => p.sourceAlertId);
      expect(ids).toContain("good-1");
      expect(ids).toContain("good-2");
      // the null-labels alert still parses (defensively) into an unknown identity
      // rather than throwing; the non-object element is dropped.
      expect(firing.length).toBe(3);
    });
  });

  describe("resolved notifications", () => {
    it("separates a cleared condition from the alerts that open an investigation", () => {
      const { firing, clearedIds } = parseAlertmanager({
        alerts: [
          alert({ status: "resolved", fingerprint: "cleared" }),
          alert({ status: "firing", fingerprint: "firing-1" }),
        ],
      });
      expect(firing.map((p) => p.sourceAlertId)).toEqual(["firing-1"]);
      expect(clearedIds).toEqual(["cleared"]);
    });
  });

  describe("fingerprint synthesis", () => {
    it("synthesizes a stable id from labels when fingerprint is absent", () => {
      const labels = { alertname: "HighCPU", container: "web-01" };
      const [a] = parseAlertmanager({
        alerts: [{ status: "firing", labels, fingerprint: undefined }],
      }).firing;
      const [b] = parseAlertmanager({
        alerts: [{ status: "firing", labels, fingerprint: undefined }],
      }).firing;
      // same labels -> same id (dedup holds), and never an undefined id.
      expect(a?.sourceAlertId).toBeTruthy();
      expect(a?.sourceAlertId).toBe(b?.sourceAlertId);
    });

    it("two distinct fingerprint-less alerts do not collide", () => {
      const { firing } = parseAlertmanager({
        alerts: [
          { status: "firing", labels: { alertname: "A", container: "x" } },
          { status: "firing", labels: { alertname: "B", container: "y" } },
        ],
      });
      expect(firing[0]?.sourceAlertId).not.toBe(firing[1]?.sourceAlertId);
    });
  });

  it("defaults firedAt to now when startsAt is missing", () => {
    const [parsed] = parseAlertmanager({
      alerts: [alert({ startsAt: undefined })],
    }).firing;
    expect(parsed?.firedAt).toBeTruthy();
    expect(() => new Date(parsed!.firedAt).toISOString()).not.toThrow();
  });
});
