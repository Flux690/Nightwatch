import { describe, expect, it } from "vitest";
import { parseAlertmanager } from "../alerts/parsers/alertmanager.js";
import { buildInitialContext } from "../agent/context.js";

// What a webhook body becomes, and what the model is then told about it.
// Identity derivation lives in service-identity.test.ts.

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

// What the model reads, built from a webhook body the way a real ingest does:
// the delivery's own facts travel with its alerts rather than being dropped.
function openingTurnFor(
  overrides: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): string {
  const { firing, delivery } = parseAlertmanager({
    alerts: [alert(overrides)],
    ...envelope,
  });
  return (
    buildInitialContext(firing, undefined, undefined, delivery).openingTurn ??
    ""
  );
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

// The user's own explanation and the expression that fired are context only:
// both enrich the prompt and neither decides anything.
describe("user context reaches the model", () => {
  const ANNOTATIONS = {
    summary: "API latency above threshold",
    description: "p99 has exceeded 2s for 10 minutes on web-01.",
    // Given to the model as a fact, never fetched: pulling a user-supplied
    // URL from the API host is an SSRF surface.
    runbook_url: "https://runbooks.internal/api-latency",
  };

  it("carries every annotation the sender wrote into the opening turn", () => {
    const [parsed] = parseAlertmanager({
      alerts: [alert({ annotations: ANNOTATIONS })],
    }).firing;
    expect(parsed?.annotations).toEqual(ANNOTATIONS);

    const turn = openingTurnFor({ annotations: ANNOTATIONS });
    for (const value of Object.values(ANNOTATIONS)) {
      expect(turn).toContain(value);
    }
  });

  // The threshold, for free, with no network call: Prometheus puts the PromQL
  // that fired in the generator link's query string.
  it("decodes the fired expression out of a Prometheus generatorURL", () => {
    const turn = openingTurnFor({
      generatorURL:
        "http://prom:9090/graph?g0.expr=rate%28http_errors_total%5B5m%5D%29+%3E+0.05&g0.tab=1",
    });
    expect(turn).toContain(
      "condition that fired: rate(http_errors_total[5m]) > 0.05",
    );
  });

  // Grafana Alerting posts the same envelope but links to a rule page carrying no
  // expression, so one parser serves both and the condition line is simply absent.
  it("renders no condition for a Grafana body, and still parses it whole", () => {
    const grafana = {
      generatorURL: "http://grafana:3000/alerting/grafana/abc123/view",
      annotations: { summary: "Disk nearly full" },
    };
    const [parsed] = parseAlertmanager({ alerts: [alert(grafana)] }).firing;
    expect(parsed?.generatorURL).toBe(grafana.generatorURL);

    const turn = openingTurnFor(grafana);
    expect(turn).not.toContain("condition that fired:");
    expect(turn).toContain("Disk nearly full");
    expect(turn).toContain(grafana.generatorURL);
  });

  it("renders an empty section when the sender wrote neither", () => {
    const [parsed] = parseAlertmanager({
      alerts: [alert({ annotations: undefined, generatorURL: undefined })],
    }).firing;
    expect(parsed?.annotations).toEqual({});
    expect(parsed?.generatorURL).toBeNull();

    const turn = openingTurnFor({
      annotations: undefined,
      generatorURL: undefined,
    });
    expect(turn).not.toContain("annotations:");
    expect(turn).not.toContain("condition that fired:");
    expect(turn).not.toContain("link:");
    // The alert itself still renders in full, which is the whole point of the
    // absent section being a section rather than a branch.
    expect(turn).toContain("type: HighCPU");
  });

  // A malformed link is the sender's, not ours: it renders as a link with no
  // condition rather than taking the batch down.
  it("survives a generatorURL that is not a URL", () => {
    const turn = openingTurnFor({ generatorURL: "not a url" });
    expect(turn).not.toContain("condition that fired:");
    expect(turn).toContain("link: not a url");
  });
});

// Facts about the envelope rather than about any alert in it. The sender has
// already worked out why these belong together; nothing here re-derives it.
describe("what a delivery says about its group", () => {
  it("tells the model what the group was formed on and what its alerts share", () => {
    const turn = openingTurnFor(
      {},
      {
        groupLabels: { alertname: "HighCPU", namespace: "prod" },
        commonLabels: { cluster: "eu-1" },
        commonAnnotations: { runbook_url: "https://runbooks/cpu" },
      },
    );
    expect(turn).toContain("Grouped on: alertname=HighCPU, namespace=prod");
    expect(turn).toContain("Held by every alert in this group: cluster=eu-1");
    expect(turn).toContain(
      "Shared annotations: runbook_url=https://runbooks/cpu",
    );
  });

  // Alertmanager sends all three keys on every delivery and leaves them empty
  // when a group shares nothing, so empty has to read as "said nothing".
  it("renders no group section when the sender described no group", () => {
    const { delivery } = parseAlertmanager({
      alerts: [alert()],
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
    });
    expect(delivery.groupContext).toBeNull();
    expect(openingTurnFor()).not.toContain("Grouped on");
  });

  // Non-string values are the sender's business: a group described partly in
  // numbers still renders the part we can read rather than nothing at all.
  it("keeps the readable labels when one of them is not a string", () => {
    const turn = openingTurnFor(
      {},
      { groupLabels: { alertname: "HighCPU", replicas: 3 } },
    );
    expect(turn).toContain("Grouped on: alertname=HighCPU");
    expect(turn).not.toContain("replicas");
  });
});
