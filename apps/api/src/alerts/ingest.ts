import type { FastifyInstance } from "fastify";
import { serviceIdentityKey } from "@nightwatch/shared";
import { parseAlertmanager, type ParsedAlert } from "./parsers/alertmanager.js";
import { resolveAlerts } from "./resolve-identity.js";
import { routeAlert } from "./route-alert.js";
import { findRunnerByToken, hashToken, touchLastUsed } from "../db/runner.js";
import { getIngestTokenHash } from "../db/user.js";
import { extractBearerToken } from "../auth/bearer.js";
import { getFleetView } from "../ws/router.js";
import { insertUnresolvedAlert } from "../db/unresolved-alerts.js";
import { logger } from "../logger.js";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>("/alerts/ingest", async (request, reply) => {
    const userAgent = request.headers["user-agent"] ?? "";
    const plaintext = extractToken(request.headers);

    if (!plaintext) {
      return reply.code(401).send({
        error: "X-Nightwatch-Token or Authorization: Bearer token required",
      });
    }

    if (!authenticate(plaintext)) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }

    let parsed: ParsedAlert[];
    try {
      parsed = parseSource(userAgent, request.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // The token authenticates the request; the alert's labels - matched
    // against the fleet's advertised services - are the sole source of
    // routing (ADR-0004 resolve-or-reject, never a token-derived guess).
    const resolution = resolveAlerts(parsed, getFleetView());
    if (resolution.kind === "no-runners") {
      for (const p of parsed) {
        tryRecordUnresolved(p.sourceAlertId, {
          sourceAlertId: p.sourceAlertId,
          identityKey: serviceIdentityKey(p.targetIdentifier),
          alertType: p.alertType,
          severity: p.severity,
          rejectionReason: "no runner connected to route this alert",
        });
      }
      return reply
        .code(503)
        .send({ error: "no runner connected to route this alert" });
    }

    let enqueued = 0;
    let skipped = 0;
    const rejected: Array<{ sourceAlertId: string; reason: string }> = [];

    // Verdicts are produced 1:1 in order with parsed (same loop in resolveAlerts),
    // so index i is always the parsed alert that yielded verdicts[i].
    for (let i = 0; i < resolution.verdicts.length; i++) {
      const verdict = resolution.verdicts[i]!;
      if (verdict.kind === "resolved") {
        if (routeAlert(verdict.alert) === "enqueued") enqueued++;
        else skipped++;
      } else {
        rejected.push({
          sourceAlertId: verdict.sourceAlertId,
          reason: verdict.reason,
        });
        const parsedAlert = parsed[i]!;
        tryRecordUnresolved(verdict.sourceAlertId, {
          sourceAlertId: verdict.sourceAlertId,
          identityKey: serviceIdentityKey(parsedAlert.targetIdentifier),
          alertType: parsedAlert.alertType,
          severity: parsedAlert.severity,
          rejectionReason: verdict.reason,
        });
      }
    }

    const received = enqueued + skipped + rejected.length;
    return reply.code(200).send({ received, enqueued, skipped, rejected });
  });

  // Lets an operator test their BYO webhook config before going live: same
  // auth, same normalizer, same fleet match as /alerts/ingest, but never
  // calls routeAlert - nothing is dispatched. Each alert is resolved
  // individually so a payload with several alerts reports which ones would
  // route and which would be rejected, instead of one failure masking the rest.
  fastify.post<{ Body: unknown }>(
    "/alerts/validate",
    async (request, reply) => {
      const plaintext = extractToken(request.headers);
      if (!plaintext) {
        return reply.code(401).send({
          error: "X-Nightwatch-Token or Authorization: Bearer token required",
        });
      }
      if (!authenticate(plaintext)) {
        return reply.code(401).send({ error: "unknown or revoked token" });
      }

      let parsed: ParsedAlert[];
      try {
        parsed = parseSource(request.headers["user-agent"] ?? "", request.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }

      if (parsed.length === 0) {
        return reply.code(400).send({
          error:
            "no alerts found in payload - expected an Alertmanager webhook or a generic { alerts: [...] } body",
        });
      }

      const fleet = getFleetView();
      const resolution = resolveAlerts(parsed, fleet);

      // verdicts are produced in 1:1 order with parsed (same loop in
      // resolveAlerts), so index i is always valid when kind === "verdicts".
      const alerts = parsed.map((p, i) => {
        let res:
          | {
              status: "resolved";
              runnerId: string;
              hostname: string | undefined;
            }
          | { status: "rejected"; reason: string };

        if (resolution.kind === "no-runners") {
          res = {
            status: "rejected",
            reason: "no runner connected to route this alert",
          };
        } else {
          const verdict = resolution.verdicts[i]!;
          res =
            verdict.kind === "resolved"
              ? {
                  status: "resolved",
                  runnerId: verdict.alert.runnerId,
                  hostname: verdict.alert.hostname,
                }
              : { status: "rejected", reason: verdict.reason };
        }

        return {
          sourceAlertId: p.sourceAlertId,
          identity: p.targetIdentifier,
          identityKey: serviceIdentityKey(p.targetIdentifier),
          alertType: p.alertType,
          severity: p.severity,
          resolution: res,
        };
      });

      return reply.code(200).send({ alerts });
    },
  );
}

// Authenticates the request only - grants no routing information. `nwi_`
// (fleet-wide) and `nwr_` (per-runner, backward compat) both just prove the
// request may submit alerts; which runner receives it is decided later, by
// matching the alert's labels against the fleet (ADR-0004).
function authenticate(plaintext: string): boolean {
  if (plaintext.startsWith("nwi_")) {
    const ingestHash = getIngestTokenHash();
    return ingestHash !== null && hashToken(plaintext) === ingestHash;
  }

  const tokenRecord = findRunnerByToken(plaintext);
  if (!tokenRecord) return false;
  // Touch before any processing so lastUsedAt reflects authenticated use.
  touchLastUsed(tokenRecord.id);
  return true;
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwatch-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return extractBearerToken(headers["authorization"]);
}

function parseSource(userAgent: string, body: unknown): ParsedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body);
  }
  throw new Error(
    "unrecognized payload - expected an Alertmanager webhook body ({ alerts: [...] })",
  );
}

function isAlertmanagerShape(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "alerts" in body &&
    Array.isArray((body as Record<string, unknown>)["alerts"])
  );
}

// A DB error writing to the unresolved feed must never abort the ingest
// response: routing of matched alerts must not be undone by a storage hiccup.
function tryRecordUnresolved(
  sourceAlertId: string,
  params: Parameters<typeof insertUnresolvedAlert>[0],
): void {
  try {
    insertUnresolvedAlert(params);
  } catch (err) {
    logger.warn({ err, sourceAlertId }, "failed to record unresolved alert");
  }
}
