import { describe, expect, it } from "vitest";
import { parseAlertmanager } from "../alerts/parsers/alertmanager.js";

// Covers the PARSER's own job: projecting fields, normalizing severity, isolating malformed
// alerts, handling resolved notifications, synthesizing a stable id. Identity derivation is
// exercised in service-identity.test.ts; here we only confirm the parser wires labels through.

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
    const [parsed] = parseAlertmanager({ alerts: [alert()] });
    expect(parsed).toMatchObject({
      sourceAlertId: "fp-1",
      alertType: "HighCPU",
      severity: "warning",
      firedAt: "2026-06-21T10:00:00Z",
    });
    // labels were wired through to the identity deriver.
    expect(parsed?.targetIdentifier).toMatchObject({ provider: "docker" });
  });

  it("normalizes severity aliases and defaults unknown to info", () => {
    const sev = (s: string | undefined) =>
      parseAlertmanager({
        alerts: [alert({ labels: { alertname: "X", severity: s } })],
      })[0]?.severity;
    expect(sev("error")).toBe("critical");
    expect(sev("critical")).toBe("critical");
    expect(sev("warn")).toBe("warning");
    expect(sev("page")).toBe("info");
    expect(sev(undefined)).toBe("info");
  });

  it("throws only when the envelope itself is not an alerts array", () => {
    expect(() => parseAlertmanager({})).toThrow(/missing alerts array/);
    expect(() => parseAlertmanager({ alerts: "nope" })).toThrow(
      /missing alerts array/,
    );
  });

  describe("batch independence", () => {
    it("a malformed alert is skipped without aborting routable siblings", () => {
      const parsed = parseAlertmanager({
        alerts: [
          alert({ fingerprint: "good-1" }),
          // labels:null used to throw on labels["alertname"] and lose the batch
          { status: "firing", labels: null, fingerprint: "bad-1" },
          "not-an-object",
          alert({ fingerprint: "good-2" }),
        ],
      });
      const ids = parsed.map((p) => p.sourceAlertId);
      expect(ids).toContain("good-1");
      expect(ids).toContain("good-2");
      // the null-labels alert still parses (defensively) into an unknown identity
      // rather than throwing; the non-object element is dropped.
      expect(parsed.length).toBe(3);
    });
  });

  describe("resolved notifications", () => {
    it("skips status:resolved alerts so a cleared condition opens no investigation", () => {
      const parsed = parseAlertmanager({
        alerts: [
          alert({ status: "resolved", fingerprint: "cleared" }),
          alert({ status: "firing", fingerprint: "firing-1" }),
        ],
      });
      expect(parsed.map((p) => p.sourceAlertId)).toEqual(["firing-1"]);
    });
  });

  describe("fingerprint synthesis", () => {
    it("synthesizes a stable id from labels when fingerprint is absent", () => {
      const labels = { alertname: "HighCPU", container: "web-01" };
      const [a] = parseAlertmanager({
        alerts: [{ status: "firing", labels, fingerprint: undefined }],
      });
      const [b] = parseAlertmanager({
        alerts: [{ status: "firing", labels, fingerprint: undefined }],
      });
      // same labels -> same id (dedup holds), and never an undefined id.
      expect(a?.sourceAlertId).toBeTruthy();
      expect(a?.sourceAlertId).toBe(b?.sourceAlertId);
    });

    it("two distinct fingerprint-less alerts do not collide", () => {
      const parsed = parseAlertmanager({
        alerts: [
          { status: "firing", labels: { alertname: "A", container: "x" } },
          { status: "firing", labels: { alertname: "B", container: "y" } },
        ],
      });
      expect(parsed[0]?.sourceAlertId).not.toBe(parsed[1]?.sourceAlertId);
    });
  });

  it("defaults firedAt to now when startsAt is missing", () => {
    const [parsed] = parseAlertmanager({
      alerts: [alert({ startsAt: undefined })],
    });
    expect(parsed?.firedAt).toBeTruthy();
    expect(() => new Date(parsed!.firedAt).toISOString()).not.toThrow();
  });
});
