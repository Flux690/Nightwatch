import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db/client.js";
import { listUnresolvedAlerts } from "../db/unresolved-alerts.js";
import { registerAlertRoutes } from "../alerts/ingest.js";
import { registerRemediationRoutes } from "../remediation/routes.js";
import { generateRunnerToken } from "../db/runner.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
import { dockerService, manifest } from "./manifest-helper.js";

const RUNNER_TOKEN_ID = "unresolved-feed-runner";

function alertBatch(
  alerts: Array<{
    fingerprint: string;
    container: string;
    alertname?: string;
    severity?: string;
  }>,
) {
  return {
    alerts: alerts.map((a) => ({
      status: "firing",
      labels: {
        alertname: a.alertname ?? "HighCPU",
        severity: a.severity ?? "warning",
        container: a.container,
      },
      annotations: { summary: "CPU high" },
      startsAt: new Date().toISOString(),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: a.fingerprint,
    })),
    version: "4",
    groupKey: "test",
    receiver: "nightwatch",
    status: "firing",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://localhost:9093",
  };
}

describe("unresolved alerts feed", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let VALID_TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    registerRunner(
      RUNNER_TOKEN_ID,
      () => {},
      () => {},
    );
    setRunnerManifest(
      RUNNER_TOKEN_ID,
      manifest("runner-unresolved-feed", "host-feed", [
        dockerService("web-01"),
      ]),
    );

    const { plaintext } = generateRunnerToken("unresolved-test");
    VALID_TOKEN = plaintext;

    server = Fastify({ logger: false });
    await registerAlertRoutes(server);
    await registerRemediationRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    unregisterRunner(RUNNER_TOKEN_ID);
    cleanupDb();
    vi.unstubAllEnvs();
  });

  async function ingest(
    alerts: Array<{
      fingerprint: string;
      container: string;
      alertname?: string;
      severity?: string;
    }>,
  ) {
    return fetch(`http://127.0.0.1:${port}/alerts/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nightwatch-token": VALID_TOKEN,
      },
      body: JSON.stringify(alertBatch(alerts)),
    });
  }

  describe("ingest seam - recording rejected alerts", () => {
    it("records a rejected (unmatched) alert with its parsed identity key, type, severity, and reason", async () => {
      const res = await ingest([
        { fingerprint: "fp-unmatched-1", container: "ghost-svc" },
      ]);
      expect(res.status).toBe(200);

      const recorded = listUnresolvedAlerts().find(
        (a) => a.sourceAlertId === "fp-unmatched-1",
      );
      expect(recorded).toBeDefined();
      expect(recorded!.identityKey).toBe("docker/ghost-svc/ghost-svc");
      expect(recorded!.alertType).toBe("HighCPU");
      expect(recorded!.severity).toBe("warning");
      expect(recorded!.rejectionReason).toMatch(/no runner advertises/i);
    });

    it("does not record a successfully resolved alert in the unresolved store", async () => {
      const before = listUnresolvedAlerts().length;
      const res = await ingest([
        { fingerprint: "fp-resolved-1", container: "web-01" },
      ]);
      expect(res.status).toBe(200);
      expect(listUnresolvedAlerts().length).toBe(before);
    });

    it("records only the rejected alert in a mixed batch, leaving the matched one dispatched", async () => {
      const before = listUnresolvedAlerts().length;
      const res = await ingest([
        { fingerprint: "fp-mixed-match-2", container: "web-01" },
        { fingerprint: "fp-mixed-reject-2", container: "unknown-svc" },
      ]);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        received: number;
        enqueued: number;
        rejected: Array<{ sourceAlertId: string; reason: string }>;
      };
      expect(body.received).toBe(2);
      expect(body.enqueued).toBe(1);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0]!.sourceAlertId).toBe("fp-mixed-reject-2");

      const after = listUnresolvedAlerts();
      expect(after.length).toBe(before + 1);
      expect(
        after.find((a) => a.sourceAlertId === "fp-mixed-reject-2"),
      ).toBeDefined();
      expect(
        after.find((a) => a.sourceAlertId === "fp-mixed-match-2"),
      ).toBeUndefined();
    });

    it("captures the severity from the alert label (critical bypasses rate-limit but is still recorded if unmatched)", async () => {
      const res = await ingest([
        {
          fingerprint: "fp-critical-unmatched",
          container: "no-such-service",
          severity: "critical",
        },
      ]);
      expect(res.status).toBe(200);

      const recorded = listUnresolvedAlerts().find(
        (a) => a.sourceAlertId === "fp-critical-unmatched",
      );
      expect(recorded).toBeDefined();
      expect(recorded!.severity).toBe("critical");
    });
  });

  describe("ingest seam - no-runners path", () => {
    it("records each alert with a no-runner reason before returning 503", async () => {
      // Unregister from the WS registry so getFleetView() returns an empty fleet.
      // The DB token row remains, so authentication still passes.
      unregisterRunner(RUNNER_TOKEN_ID);
      try {
        const res = await ingest([
          {
            fingerprint: "fp-no-runner-1",
            container: "any-svc",
            severity: "warning",
          },
        ]);
        expect(res.status).toBe(503);

        const recorded = listUnresolvedAlerts().find(
          (a) => a.sourceAlertId === "fp-no-runner-1",
        );
        expect(recorded).toBeDefined();
        expect(recorded!.identityKey).toBe("docker/any-svc/any-svc");
        expect(recorded!.rejectionReason).toMatch(/no runner connected/i);
      } finally {
        registerRunner(
          RUNNER_TOKEN_ID,
          () => {},
          () => {},
        );
        setRunnerManifest(
          RUNNER_TOKEN_ID,
          manifest("runner-unresolved-feed", "host-feed", [
            dockerService("web-01"),
          ]),
        );
      }
    });
  });

  describe("route seam - GET /unresolved-alerts", () => {
    it("returns 401 without a valid console session", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/unresolved-alerts`);
      expect(res.status).toBe(401);
    });

    it("returns the feed with correct shape for each recorded alert", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/unresolved-alerts`, {
        headers: { Cookie: `nw_auth=${SESSION}` },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UnresolvedAlertRecord[];
      expect(Array.isArray(body)).toBe(true);

      const entry = body.find((a) => a.sourceAlertId === "fp-unmatched-1");
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        sourceAlertId: "fp-unmatched-1",
        identityKey: "docker/ghost-svc/ghost-svc",
        alertType: "HighCPU",
        severity: "warning",
      });
      expect(entry!.rejectionReason).toMatch(/no runner advertises/i);
      expect(typeof entry!.createdAt).toBe("string");
    });

    it("returns results newest-first", async () => {
      // Seed two records with explicit timestamps so ordering is deterministic.
      getDb()
        .prepare(
          `INSERT INTO unresolved_alerts
             (source_alert_id, identity_key, alert_type, severity, rejection_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fp-order-older",
          "docker/old/old",
          "Alert",
          "warning",
          "reason",
          "2024-01-01T00:00:00.000Z",
        );
      getDb()
        .prepare(
          `INSERT INTO unresolved_alerts
             (source_alert_id, identity_key, alert_type, severity, rejection_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fp-order-newer",
          "docker/new/new",
          "Alert",
          "warning",
          "reason",
          "2025-01-01T00:00:00.000Z",
        );

      const res = await fetch(`http://127.0.0.1:${port}/unresolved-alerts`, {
        headers: { Cookie: `nw_auth=${SESSION}` },
      });
      const body = (await res.json()) as UnresolvedAlertRecord[];
      const orderItems = body.filter((a) =>
        a.sourceAlertId.startsWith("fp-order-"),
      );
      expect(orderItems).toHaveLength(2);
      expect(orderItems[0]!.sourceAlertId).toBe("fp-order-newer");
      expect(orderItems[1]!.sourceAlertId).toBe("fp-order-older");
    });

    it("returns at most 100 records even when more are stored", async () => {
      for (let i = 0; i < 110; i++) {
        getDb()
          .prepare(
            `INSERT INTO unresolved_alerts
               (source_alert_id, identity_key, alert_type, severity, rejection_reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `fp-cap-${i}`,
            "docker/svc/svc",
            "Alert",
            "warning",
            "reason",
            new Date(Date.now() + i).toISOString(),
          );
      }

      const res = await fetch(`http://127.0.0.1:${port}/unresolved-alerts`, {
        headers: { Cookie: `nw_auth=${SESSION}` },
      });
      const body = (await res.json()) as UnresolvedAlertRecord[];
      expect(body.length).toBe(100);
    });
  });
});
