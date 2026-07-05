import { describe, expect, it } from "vitest";
import type { FleetRunner } from "@nightwatch/shared";
import type { ParsedAlert } from "../alerts/parsers/alertmanager.js";
import { resolveAlerts } from "../alerts/resolve-identity.js";

function parsedAlert(overrides: Partial<ParsedAlert> = {}): ParsedAlert {
  return {
    sourceAlertId: "fp-1",
    targetIdentifier: { provider: "docker", project: "myapp", service: "api" },
    alertType: "ContainerDown",
    severity: "warning",
    firedAt: "2026-06-21T10:00:00Z",
    rawPayload: {},
    ...overrides,
  };
}

function fleetRunner(overrides: Partial<FleetRunner> = {}): FleetRunner {
  return {
    runnerId: "runner-a",
    hostname: "host-a",
    online: true,
    lastSeen: Date.now(),
    services: [],
    ...overrides,
  };
}

describe("resolveAlerts", () => {
  it("resolves a uniquely-matching alert to its hosting runner", () => {
    const fleet = [
      fleetRunner({
        runnerId: "runner-a",
        hostname: "host-a",
        services: [
          {
            identity: { provider: "docker", project: "myapp", service: "api" },
            status: "running",
          },
        ],
      }),
    ];

    const result = resolveAlerts([parsedAlert()], fleet);

    expect(result.kind).toBe("verdicts");
    if (result.kind !== "verdicts") return;
    expect(result.verdicts).toHaveLength(1);
    const verdict = result.verdicts[0]!;
    expect(verdict.kind).toBe("resolved");
    if (verdict.kind !== "resolved") return;
    expect(verdict.alert).toEqual({
      ...parsedAlert(),
      runnerId: "runner-a",
      hostname: "host-a",
    });
  });

  it("rejects with a diagnostic message when no fleet service matches", () => {
    const fleet = [
      fleetRunner({
        runnerId: "runner-a",
        hostname: "host-a",
        services: [
          {
            identity: { provider: "docker", project: "other", service: "web" },
            status: "running",
          },
        ],
      }),
    ];

    const result = resolveAlerts(
      [
        parsedAlert({
          targetIdentifier: {
            provider: "docker",
            project: "myapp",
            service: "api",
          },
        }),
      ],
      fleet,
    );

    expect(result.kind).toBe("verdicts");
    if (result.kind !== "verdicts") return;
    const verdict = result.verdicts[0]!;
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.reason).toMatch(/docker\/myapp\/api/);
    expect(verdict.reason).toMatch(/docker\/other\/web/);
  });

  it("rejects with HTTP 400 listing the ambiguous runners when the same service is advertised twice", () => {
    const identity = {
      provider: "docker" as const,
      project: "myapp",
      service: "api",
    };
    const fleet = [
      fleetRunner({
        runnerId: "runner-a",
        hostname: "host-a",
        services: [{ identity, status: "running" }],
      }),
      fleetRunner({
        runnerId: "runner-b",
        hostname: "host-b",
        services: [{ identity, status: "running" }],
      }),
    ];

    const result = resolveAlerts(
      [parsedAlert({ targetIdentifier: identity })],
      fleet,
    );

    expect(result.kind).toBe("verdicts");
    if (result.kind !== "verdicts") return;
    const verdict = result.verdicts[0]!;
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.reason).toMatch(/ambiguous/i);
    expect(verdict.reason).toMatch(/host-a/);
    expect(verdict.reason).toMatch(/host-b/);
  });

  it("returns no-runners when no runner is online at all, distinct from a label mismatch", () => {
    const result = resolveAlerts([parsedAlert()], []);

    expect(result.kind).toBe("no-runners");
  });

  it("rejects an offline-only match as a 400 label mismatch, not a no-runners result, when other runners are online", () => {
    const identity = {
      provider: "docker" as const,
      project: "myapp",
      service: "api",
    };
    const fleet = [
      fleetRunner({
        runnerId: "runner-offline",
        hostname: "host-offline",
        online: false,
        services: [{ identity, status: "running" }],
      }),
      fleetRunner({ runnerId: "runner-online", hostname: "host-online" }),
    ];

    const result = resolveAlerts(
      [parsedAlert({ targetIdentifier: identity })],
      fleet,
    );

    expect(result.kind).toBe("verdicts");
    if (result.kind !== "verdicts") return;
    const verdict = result.verdicts[0]!;
    expect(verdict.kind).toBe("rejected");
  });

  it("resolves matched alerts and reports rejected alerts in the same batch without suppressing either", () => {
    const fleet = [
      fleetRunner({
        runnerId: "runner-a",
        hostname: "host-a",
        services: [
          {
            identity: { provider: "docker", project: "myapp", service: "api" },
            status: "running",
          },
        ],
      }),
    ];

    const matched = parsedAlert({
      sourceAlertId: "fp-match",
      targetIdentifier: {
        provider: "docker",
        project: "myapp",
        service: "api",
      },
    });
    const unmatched = parsedAlert({
      sourceAlertId: "fp-no-match",
      targetIdentifier: {
        provider: "docker",
        project: "ghost",
        service: "ghost",
      },
    });

    const result = resolveAlerts([matched, unmatched], fleet);

    expect(result.kind).toBe("verdicts");
    if (result.kind !== "verdicts") return;
    expect(result.verdicts).toHaveLength(2);

    const first = result.verdicts[0]!;
    expect(first.kind).toBe("resolved");
    if (first.kind !== "resolved") return;
    expect(first.alert.runnerId).toBe("runner-a");

    const second = result.verdicts[1]!;
    expect(second.kind).toBe("rejected");
    if (second.kind !== "rejected") return;
    expect(second.sourceAlertId).toBe("fp-no-match");
    expect(second.reason).toMatch(/ghost\/ghost/);
  });
});
