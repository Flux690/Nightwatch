import type { FastifyInstance } from "fastify";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit, tryDebounce, enqueueInvestigation } from "./queue.js";
import type { NormalizedAlert } from "@nightwatch/shared";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>("/alerts/ingest", async (request, reply) => {
    const userAgent = request.headers["user-agent"] ?? "";
    const installationId = extractInstallationId(request.headers);

    if (!installationId) {
      return reply
        .code(401)
        .send({ error: "X-Installation-Id header required" });
    }

    let alerts: NormalizedAlert[];
    try {
      alerts = parseSource(userAgent, request.body, installationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    let enqueued = 0;
    let skipped = 0;

    for (const alert of alerts) {
      if (await isDuplicate(alert)) {
        skipped++;
        continue;
      }

      const allowed = await checkRateLimit(
        alert.installationId,
        alert.severity,
      );
      if (!allowed) {
        skipped++;
        fastify.log.warn({ alertId: alert.sourceAlertId }, "rate limited");
        continue;
      }

      const debounced = await tryDebounce(alert.installationId);
      if (!debounced) {
        skipped++;
        fastify.log.info({ alertId: alert.sourceAlertId }, "debounced");
        continue;
      }

      await enqueueInvestigation(alert);
      enqueued++;
      fastify.log.info(
        { alertId: alert.sourceAlertId, type: alert.alertType },
        "queued",
      );
    }

    return reply.code(200).send({ received: alerts.length, enqueued, skipped });
  });
}

function extractInstallationId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers["x-installation-id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

function parseSource(
  userAgent: string,
  body: unknown,
  installationId: string,
): NormalizedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body, installationId);
  }
  fastify_log_stub(body);
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

function fastify_log_stub(body: unknown): void {
  console.log(
    "[ingest] unknown source, ignoring:",
    JSON.stringify(body).slice(0, 200),
  );
}
