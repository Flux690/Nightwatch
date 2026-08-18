import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isMetricsBackendKind } from "@nightwarden/shared";
import type {
  MetricsBackendKind,
  MetricsBackendStatus,
} from "@nightwarden/shared";
import { requireSession } from "../../auth/session.js";
import {
  deleteMetricsBackend,
  getMetricsBackendRow,
  listMetricsBackendRows,
  saveMetricsBackend,
} from "../../db/metrics.js";
import { logger } from "../../logger.js";
import { MetricsApiError, instantQuery, alertingRules } from "./client.js";
import {
  encryptedAuthorization,
  endpointFrom,
  getMetricsBackend,
  listMetricsBackends,
  statusOf,
} from "./backends.js";
import { METRICS_PRESETS } from "./presets.js";

const EndpointSchema = z.object({
  url: z.string().min(1),
  authHeader: z.string().min(1).optional(),
  basicUsername: z.string().min(1).optional(),
  basicPassword: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
});

const ConnectSchema = z.object({
  kind: z.string().refine(isMetricsBackendKind, "unknown metrics backend"),
  query: EndpointSchema,
  // Absent is a legitimate configuration and a stated limitation, not an
  // error: without it the investigation can never confirm the alert cleared.
  rules: EndpointSchema.optional(),
});

/* Derived, never asked for: the product's own name is unique until a second of
   the same kind is connected, and then it is that name with a number. */
function availableName(kind: MetricsBackendKind): string {
  const taken = new Set(
    listMetricsBackendRows().map((row) => row.label.toLowerCase()),
  );
  const base = METRICS_PRESETS[kind].label;
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function statusPayload(): MetricsBackendStatus[] {
  const rows = new Map(listMetricsBackendRows().map((r) => [r.id, r]));
  return listMetricsBackends().flatMap((backend) => {
    const row = rows.get(backend.id);
    return row === undefined ? [] : [statusOf(backend, row.validatedAt)];
  });
}

// bad_query maps to 400 explicitly: a Prometheus-compatible backend reports
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
      const name = availableName(kind);
      try {
        await instantQuery(endpointFrom(query, name), "up");
        if (rules !== undefined) {
          await alertingRules(endpointFrom(rules, `${name} rules`));
        }
        const id = saveMetricsBackend({
          kind,
          label: name,
          queryUrl: query.url,
          queryAuthEncrypted: encryptedAuthorization(query),
          queryOrgId: query.orgId ?? null,
          rulesUrl: rules?.url ?? null,
          rulesAuthEncrypted:
            rules === undefined ? null : encryptedAuthorization(rules),
          rulesOrgId: rules?.orgId ?? null,
        });
        logger.info({ kind, id, url: query.url }, "metrics backend connected");
        const saved = getMetricsBackend(id);
        const row = getMetricsBackendRow(id);
        if (saved === null || row === null) {
          return reply.code(500).send({ error: "backend was not stored" });
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
      if (!deleteMetricsBackend(request.params.id)) {
        return reply.code(404).send({ error: "No such metrics backend" });
      }
      logger.info({ id: request.params.id }, "metrics backend disconnected");
      return reply.code(204).send();
    },
  );
}
