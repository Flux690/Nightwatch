import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isMetricsSourceKind } from "@nightwarden/shared";
import type { MetricsSourceStatus } from "@nightwarden/shared";
import { requireSession } from "../../auth/session.js";
import {
  deleteMetricsSource,
  getMetricsSourceRow,
  listMetricsSourceRows,
  metricsSourceOfKind,
  saveMetricsSource,
} from "./store.js";
import { logger } from "../../logger.js";
import { MetricsApiError, instantQuery, alertingRules } from "./client.js";
import {
  endpointFrom,
  getMetricsSource,
  listMetricsSources,
  secretFor,
  statusOf,
} from "./sources.js";
import { METRICS_PRESETS } from "./presets.js";

const EndpointSchema = z.object({
  url: z.string().min(1),
  authHeader: z.string().min(1).optional(),
  basicUsername: z.string().min(1).optional(),
  basicPassword: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  // AMP only: SigV4 request-signing credentials in place of the above.
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  sessionToken: z.string().min(1).optional(),
});

const ConnectSchema = z.object({
  kind: z.string().refine(isMetricsSourceKind, "unknown metrics source"),
  query: EndpointSchema,
  // Absent is a legitimate configuration and a stated limitation, not an
  // error: without it the investigation can never confirm the alert cleared.
  rules: EndpointSchema.optional(),
});

function statusPayload(): MetricsSourceStatus[] {
  const rows = new Map(listMetricsSourceRows().map((r) => [r.id, r]));
  return listMetricsSources().flatMap((source) => {
    const row = rows.get(source.id);
    return row === undefined ? [] : [statusOf(source, row.validatedAt)];
  });
}

// bad_query maps to 400 explicitly: a Prometheus-compatible source reports
// envelope errors with HTTP 200, which must not leak through as a success.
async function sendMetricsError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof MetricsApiError) {
    const status =
      err.code === "unauthorized"
        ? err.status
        : err.code === "bad_query"
          ? 400
          : 502;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function registerMetricsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Status only - like every other integration, no credential rides a response.
  fastify.get(
    "/integrations/metrics",
    { preHandler: requireSession },
    async () => statusPayload(),
  );

  /* Connect: probe both endpoints with the exact calls an investigation makes,
     before anything is written. A rules URL that answers nothing is refused
     here rather than discovered at 3am by an investigation that cannot close. */
  fastify.post(
    "/integrations/metrics",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ConnectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { kind, query, rules } = parsed.data;
      const name = METRICS_PRESETS[kind].label;
      /* One connection per product, because the thing you point at is already
         an aggregate: Prometheus is scaled by putting Thanos or Mimir in front
         of it, not by listing every replica here. */
      if (metricsSourceOfKind(kind) !== null) {
        return reply.code(409).send({
          error: `${name} is already connected. Disconnect it first.`,
        });
      }
      try {
        await instantQuery(endpointFrom(query, name, kind), "up");
        if (rules !== undefined) {
          await alertingRules(endpointFrom(rules, `${name} rules`, kind));
        }
        const id = saveMetricsSource({
          kind,
          label: name,
          queryUrl: query.url,
          queryAuthorization: secretFor(query, kind),
          queryOrgId: query.orgId ?? null,
          rulesUrl: rules?.url ?? null,
          rulesAuthorization:
            rules === undefined ? null : secretFor(rules, kind),
          rulesOrgId: rules?.orgId ?? null,
        });
        logger.info({ kind, id, url: query.url }, "metrics source connected");
        const saved = getMetricsSource(id);
        const row = getMetricsSourceRow(id);
        if (saved === null || row === null) {
          return reply.code(500).send({ error: "source was not stored" });
        }
        return await reply.code(201).send(statusOf(saved, row.validatedAt));
      } catch (err) {
        return sendMetricsError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/integrations/metrics/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      if (!deleteMetricsSource(request.params.id)) {
        return reply.code(404).send({ error: "No such metrics source" });
      }
      logger.info({ id: request.params.id }, "metrics source disconnected");
      return reply.code(204).send();
    },
  );
}
