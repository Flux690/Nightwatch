import { probeSignal } from "../reachability.js";
import { z } from "zod";
import { readable } from "../../request-body.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isMetricsSourceKind } from "@nightwarden/shared";
import type { MetricsSourceStatus } from "@nightwarden/shared";
import { requireSession } from "../../auth/session.js";
import {
  deleteMetricsSource,
  metricsSourceRow,
  saveMetricsSource,
} from "./store.js";
import { logger } from "../../logger.js";
import { MetricsApiError, instantQuery, alertingRules } from "./client.js";
import {
  endpointFrom,
  getMetricsSource,
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

async function statusPayload(): Promise<MetricsSourceStatus> {
  return statusOf(
    await getMetricsSource(),
    (await metricsSourceRow())?.validatedAt ?? null,
  );
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
    async () => await statusPayload(),
  );

  // Probed with the calls an investigation makes, so a rules URL answering
  // nothing is refused here rather than found by a run that cannot close.
  fastify.post(
    "/integrations/metrics",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ConnectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { kind, query, rules } = parsed.data;
      const name = METRICS_PRESETS[kind].label;
      // One source, whatever product: what you point at is already an
      // aggregate, so a second is a mistake rather than a name to invent.
      const connected = await getMetricsSource();
      if (connected !== null) {
        return reply.code(409).send({
          error: `${connected.label} is already connected. Disconnect it first.`,
        });
      }
      try {
        await instantQuery(
          endpointFrom(query, name, kind),
          probeSignal(),
          "up",
        );
        if (rules !== undefined) {
          await alertingRules(
            endpointFrom(rules, `${name} rules`, kind),
            probeSignal(),
          );
        }
        await saveMetricsSource({
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
        logger.info({ kind, url: query.url }, "metrics source connected");
        return await reply.code(201).send(await statusPayload());
      } catch (err) {
        return await sendMetricsError(reply, err);
      }
    },
  );

  // No id, as Loki has none: there is one source to disconnect or none.
  fastify.delete(
    "/integrations/metrics",
    { preHandler: requireSession },
    async (_request, reply) => {
      await deleteMetricsSource();
      logger.info({}, "metrics source disconnected");
      return reply.code(204).send();
    },
  );
}
