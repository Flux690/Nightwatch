import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit } from "./rate-limit.js";
import { batchWindow } from "./batch-window.js";
import { dispatcher } from "../dispatcher.js";
import { findTokenByValue, hashToken, touchLastUsed } from "../db/tokens.js";
import { getIngestTokenHash } from "../db/user.js";
import { extractBearerToken } from "../auth/bearer.js";
import { getRunnerIdentity, listRunners } from "../ws/router.js";
import { logger } from "../logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";

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

    const resolved = plaintext.startsWith("nwi_")
      ? resolveViaIngestCredential(plaintext)
      : resolveViaRunnerToken(plaintext);

    if (resolved === null) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }
    if (resolved.kind === "rejected") {
      return reply.code(resolved.status).send({ error: resolved.error });
    }

    const { runnerId, hostname } = resolved;

    let alerts: NormalizedAlert[];
    try {
      alerts = parseSource(userAgent, request.body, runnerId, hostname);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    let enqueued = 0;
    let skipped = 0;

    for (const alert of alerts) {
      // 1. Derived dedup: same alert already active or durably suspended.
      if (isDuplicate(alert)) {
        skipped++;
        continue;
      }

      // 2. Intra-window dedup: same tokenId+sourceAlertId already queued in
      //    the batch window. True duplicate — the model would see it twice.
      if (batchWindow.has(alert.runnerId, alert.sourceAlertId)) {
        skipped++;
        continue;
      }

      // 3. Rate limit: per-server budget.
      if (!checkRateLimit(alert.runnerId, alert.severity)) {
        skipped++;
        fastify.log.warn({ alertId: alert.sourceAlertId }, "rate limited");
        continue;
      }

      // 4. Route: inject into the one active alert investigation (if any) or
      //    add to the operator-wide batch window. A suspended session is not
      //    in the active set, so it falls through to the batch window and a
      //    new session is created — suspended sessions never receive injections
      //    (CONTEXT.md alert pipeline).
      const activeSessionId = dispatcher.getActiveAlertSession();
      if (activeSessionId !== null) {
        dispatcher.injectAlert(activeSessionId, alert);
        fastify.log.info(
          { alertId: alert.sourceAlertId, sessionId: activeSessionId },
          "alert injected into active run",
        );
      } else {
        batchWindow.add(alert);
        fastify.log.info(
          { alertId: alert.sourceAlertId, type: alert.alertType },
          "alert added to batch window",
        );
      }

      enqueued++;
    }

    return reply.code(200).send({ received: alerts.length, enqueued, skipped });
  });
}

type AuthResolution =
  | { kind: "resolved"; runnerId: string; hostname: string | undefined }
  | { kind: "rejected"; status: number; error: string };

// nwr_ tokens carry a runner identity directly (per-server credential): the
// token's own runnerId, or whichever runner connected with it, or the token's
// id as a last resort before any manifest arrives.
function resolveViaRunnerToken(plaintext: string): AuthResolution | null {
  const tokenRecord = findTokenByValue(plaintext);
  if (!tokenRecord) return null;

  // Touch before any processing so lastUsedAt reflects authenticated use.
  touchLastUsed(tokenRecord.id);

  // Use the token's UUID as the internal identifier for all dispatch and
  // session records — the plaintext never flows downstream.
  const tokenId = tokenRecord.id;
  const identity = getRunnerIdentity(tokenId);
  return {
    kind: "resolved",
    runnerId: tokenRecord.runnerId ?? identity?.runnerId ?? tokenId,
    hostname: identity?.hostname ?? undefined,
  };
}

// nwi_ tokens carry no runner identity (fleet-wide credential): until alert
// labels can be matched against the fleet (a later slice), a single connected
// runner is the only deterministic target. Zero or multiple runners must
// reject loudly rather than guess (ADR-0004).
function resolveViaIngestCredential(plaintext: string): AuthResolution | null {
  const ingestHash = getIngestTokenHash();
  if (!ingestHash || hashToken(plaintext) !== ingestHash) return null;

  const online = listRunners().filter((r) => r.online);
  if (online.length === 0) {
    return {
      kind: "rejected",
      status: 503,
      error: "no runner connected to route this alert",
    };
  }
  if (online.length > 1) {
    return {
      kind: "rejected",
      status: 400,
      error:
        "label-based resolution required for multi-runner fleets, coming soon",
    };
  }

  const only = online[0]!;
  return {
    kind: "resolved",
    runnerId: only.runnerId ?? only.tokenId,
    hostname: only.hostname ?? undefined,
  };
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwatch-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return extractBearerToken(headers["authorization"]);
}

function parseSource(
  userAgent: string,
  body: unknown,
  runnerId: string,
  hostname: string | undefined,
): NormalizedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body, runnerId, hostname);
  }
  logger.warn(
    { preview: JSON.stringify(body).slice(0, 200) },
    "ingest: unknown alert source, ignoring",
  );
  return [];
}

function isAlertmanagerShape(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "alerts" in body &&
    Array.isArray((body as Record<string, unknown>)["alerts"])
  );
}
