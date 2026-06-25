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

    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.alerts).toEqual([
      {
        ...parsedAlert(),
        runnerId: "runner-a",
        hostname: "host-a",
      },
    ]);
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

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/docker\/myapp\/api/);
    expect(result.error).toMatch(/docker\/other\/web/);
  });

  it("rejects with HTTP 400 listing the ambiguous runners when the same service is advertised twice", () => {
    const identity = { provider: "docker" as const, project: "myapp", service: "api" };
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

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/ambiguous/i);
    expect(result.error).toMatch(/host-a/);
    expect(result.error).toMatch(/host-b/);
  });

  it("rejects with HTTP 503 when no runner is online at all, distinct from a label mismatch", () => {
    const result = resolveAlerts([parsedAlert()], []);

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/runner/i);
  });

  it("rejects an offline-only match as a 400 label mismatch, not a 503 fleet-empty error, when other runners are online", () => {
    const identity = { provider: "docker" as const, project: "myapp", service: "api" };
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

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(400);
  });
});
