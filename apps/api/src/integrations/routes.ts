import { probeSignal } from "./reachability.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "../auth/session.js";
import {
  deleteGitHubIntegration,
  getGitHubIntegration,
  saveGitHubIntegration,
  updateGitHubIntegrationRepo,
  deleteLokiIntegration,
  getLokiIntegration,
  saveLokiIntegration,
  deleteSentryIntegration,
  getSentryIntegration,
  saveSentryIntegration,
} from "./store.js";
import {
  deleteAlertSource,
  generateAlertSourceToken,
  getAlertSource,
} from "./alert-sources.js";
import { isAlertSourceKind } from "@nightwarden/shared";
import type { AlertSourceKind } from "@nightwarden/shared";
import {
  GitHubApiError,
  listRepos,
  ownerIsOrganization,
  validateRepoAccess,
} from "./github.js";
import { LokiApiError, probeLoki } from "./loki.js";
import { SentryApiError, probeSentry } from "./sentry.js";
import { preflight } from "../sandbox/preflight.js";
import { teardownAll } from "../sandbox/workspace.js";
import { logger } from "../logger.js";
import { readable } from "../request-body.js";
import { publicUrl } from "../public-url.js";
import type {
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  SentryIntegrationStatus,
} from "@nightwarden/shared";

const ReposBodySchema = z.object({
  token: z.string().min(1).optional(),
  page: z.number().int().positive().optional(),
});

const LokiConnectSchema = z.object({
  url: z.string().min(1),
  authHeader: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
});

const SentryConnectSchema = z.object({
  url: z.string().min(1),
  orgSlug: z.string().min(1),
  token: z.string().min(1),
});

const ConnectBodySchema = z.object({
  token: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

const RebindBodySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

async function statusPayload(): Promise<GitHubIntegrationStatus> {
  const row = await getGitHubIntegration();
  if (!row) {
    return {
      configured: false,
      repo: null,
      expiresAt: null,
      validatedAt: null,
    };
  }
  return {
    configured: true,
    repo: `${row.repoOwner}/${row.repoName}`,
    expiresAt: row.tokenExpiresAt,
    validatedAt: row.validatedAt,
  };
}

async function sendGitHubError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof GitHubApiError) {
    const status = err.code === "network" ? 502 : err.status;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

async function lokiStatusPayload(): Promise<LokiIntegrationStatus> {
  const row = await getLokiIntegration();
  if (!row) {
    return {
      configured: false,
      url: null,
      hasAuth: false,
      hasOrgId: false,
      validatedAt: null,
    };
  }
  return {
    configured: true,
    url: row.baseUrl,
    hasAuth: row.authorization !== null,
    hasOrgId: row.orgId !== null,
    validatedAt: row.validatedAt,
  };
}

async function sendLokiError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof LokiApiError) {
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

async function sentryStatusPayload(): Promise<SentryIntegrationStatus> {
  const row = await getSentryIntegration();
  if (!row) {
    return {
      configured: false,
      url: null,
      orgSlug: null,
      validatedAt: null,
    };
  }
  return {
    configured: true,
    url: row.baseUrl,
    orgSlug: row.orgSlug,
    validatedAt: row.validatedAt,
  };
}

/* Sentry's own status is carried through rather than flattened to 502: a
   missing scope and a bad slug are both fixed by the user, in different places. */
async function sendSentryError(
  reply: FastifyReply,
  err: unknown,
): Promise<FastifyReply> {
  if (err instanceof SentryApiError) {
    const status = err.code === "network" ? 502 : err.status;
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function registerIntegrationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Status only: the plaintext token is never returned by any endpoint - there
  // is no reveal use case; regenerate on GitHub via the deep link instead.
  fastify.get(
    "/integrations/github",
    { preHandler: requireSession },
    async () => await statusPayload(),
  );

  // Sandbox prerequisites, checked when the user clicks Connect: fail
  // loud at setup time, never at 3am mid-incident.
  fastify.post(
    "/integrations/github/preflight",
    { preHandler: requireSession },
    async () => await preflight(),
  );

  // During onboarding the token rides the body; afterwards the stored
  // credential is used. POST, never GET, so a token never lands in a URL.
  fastify.post(
    "/integrations/github/repos",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ReposBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const stored = await getGitHubIntegration();
      const token = parsed.data.token ?? stored?.token ?? null;
      if (!token) {
        return reply
          .code(400)
          .send({ error: "No token provided and no integration configured" });
      }
      try {
        const { repos, hasMore } = await listRepos(
          token,
          probeSignal(),
          parsed.data.page ?? 1,
        );
        return { repos, hasMore };
      } catch (err) {
        return await sendGitHubError(reply, err);
      }
    },
  );

  // Bind: validate the exact repo with the pasted token, then encrypt + store.
  fastify.post(
    "/integrations/github",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ConnectBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { token, repo } = parsed.data;
      // The body schema regex guarantees exactly one slash with both sides
      // non-empty, so the two-element destructure cannot miss.
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const validated = await validateRepoAccess(
          token,
          probeSignal(),
          owner,
          name,
        );
        await saveGitHubIntegration({
          token,
          repoOwner: owner,
          repoName: name,
          tokenExpiresAt: validated.expiresAt,
        });
        logger.info({ repo }, "github integration configured");
        return await reply.code(201).send(await statusPayload());
      } catch (err) {
        if (err instanceof GitHubApiError && err.code === "repo_not_found") {
          const orgApprovalUrl = (await ownerIsOrganization(
            owner,
            probeSignal(),
          ))
            ? `https://github.com/organizations/${owner}/settings/personal-access-token-requests`
            : undefined;
          return reply.code(404).send({
            error: err.message,
            code: err.code,
            ...(orgApprovalUrl !== undefined && { orgApprovalUrl }),
          });
        }
        return await sendGitHubError(reply, err);
      }
    },
  );

  // Never accepts a token - only ever uses the one already stored, so the
  // request proves nothing beyond "pick a different repo".
  fastify.patch(
    "/integrations/github",
    { preHandler: requireSession },
    async (request, reply) => {
      const stored = await getGitHubIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "GitHub is not connected" });
      }
      const parsed = RebindBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const [owner, name] = parsed.data.repo.split("/") as [string, string];
      try {
        const token = stored.token;
        await validateRepoAccess(token, probeSignal(), owner, name);
        await updateGitHubIntegrationRepo(owner, name);
        logger.info(
          { repo: parsed.data.repo },
          "github integration repository changed",
        );
        return await reply.code(200).send(await statusPayload());
      } catch (err) {
        if (err instanceof GitHubApiError && err.code === "repo_not_found") {
          const orgApprovalUrl = (await ownerIsOrganization(
            owner,
            probeSignal(),
          ))
            ? `https://github.com/organizations/${owner}/settings/personal-access-token-requests`
            : undefined;
          return reply.code(404).send({
            error: err.message,
            code: err.code,
            ...(orgApprovalUrl !== undefined && { orgApprovalUrl }),
          });
        }
        return await sendGitHubError(reply, err);
      }
    },
  );

  // Deletes our stored copy only; full invalidation requires revoking on
  // GitHub. Sandboxes are torn down first, while the token still works.
  fastify.delete(
    "/integrations/github",
    { preHandler: requireSession },
    async (_request, reply) => {
      await teardownAll("disconnected");
      await deleteGitHubIntegration();
      logger.info("github integration disconnected");
      return reply.code(204).send();
    },
  );

  fastify.get(
    "/integrations/loki",
    { preHandler: requireSession },
    async () => await lokiStatusPayload(),
  );

  // Probed before saving, because it exercises auth and the tenant header: a
  // bad URL or credential fails at setup rather than at 3am.
  fastify.post(
    "/integrations/loki",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = LokiConnectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { url, authHeader, orgId } = parsed.data;
      try {
        await probeLoki(url, authHeader ?? null, orgId ?? null, probeSignal());
        await saveLokiIntegration({
          baseUrl: url,
          orgId: orgId ?? null,
          authorization: authHeader ?? null,
        });
        logger.info({ url }, "loki integration configured");
        return await reply.code(201).send(await lokiStatusPayload());
      } catch (err) {
        return await sendLokiError(reply, err);
      }
    },
  );

  fastify.delete(
    "/integrations/loki",
    { preHandler: requireSession },
    async (_request, reply) => {
      await deleteLokiIntegration();
      logger.info("loki integration disconnected");
      return reply.code(204).send();
    },
  );

  fastify.get(
    "/integrations/sentry",
    { preHandler: requireSession },
    async () => await sentryStatusPayload(),
  );

  // Probed on both scopes before saving: a token carrying only event:read would
  // otherwise connect cleanly and answer nothing about releases mid-incident.
  fastify.post(
    "/integrations/sentry",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = SentryConnectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { url, orgSlug, token } = parsed.data;
      try {
        await probeSentry({ baseUrl: url, orgSlug, token }, probeSignal());
        await saveSentryIntegration({ baseUrl: url, orgSlug, token });
        logger.info({ url, orgSlug }, "sentry integration configured");
        return await reply.code(201).send(await sentryStatusPayload());
      } catch (err) {
        return await sendSentryError(reply, err);
      }
    },
  );

  fastify.delete(
    "/integrations/sentry",
    { preHandler: requireSession },
    async (_request, reply) => {
      await deleteSentryIntegration();
      logger.info("sentry integration disconnected");
      return reply.code(204).send();
    },
  );

  // Credential issued here (the config plane); deliveries hit /alerts/ingest
  // (the data plane) with it. One family, so a new sender is a kind.
  const knownSender = [requireSession, requireKnownAlertSource];

  fastify.get<AlertSourceRoute>(
    "/integrations/alerting/:kind",
    { preHandler: knownSender },
    async (request) => {
      const source = await getAlertSource(request.params.kind);
      return {
        configured: source !== null,
        ingestUrl: `${publicUrl(request)}/api/alerts/ingest`,
        // Delivery proof, not configuration state: null until that sender
        // actually posts, and again after a rotation.
        lastReceivedAt: source?.lastReceivedAt ?? null,
      };
    },
  );

  fastify.post<AlertSourceRoute>(
    "/integrations/alerting/:kind/credential",
    { preHandler: knownSender },
    async (request, reply) =>
      reply
        .code(201)
        .send({ token: await generateAlertSourceToken(request.params.kind) }),
  );

  // Deleting the row is the revoke: the credential stops matching on the next
  // delivery, which is the only place it is ever checked.
  fastify.delete<AlertSourceRoute>(
    "/integrations/alerting/:kind",
    { preHandler: knownSender },
    async (request, reply) => {
      await deleteAlertSource(request.params.kind);
      logger.info({ kind: request.params.kind }, "alert source disconnected");
      return reply.code(204).send();
    },
  );
}

// Guarded the way requireSession guards identity: the check is the route's
// precondition, not a branch inside every handler.
interface AlertSourceRoute {
  Params: { kind: AlertSourceKind };
}

// Checked against the shared list, so the frontend and the API cannot disagree
// about which senders exist.
async function requireKnownAlertSource(
  request: FastifyRequest<{ Params: { kind: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { kind } = request.params;
  if (!isAlertSourceKind(kind)) {
    await reply.code(404).send({ error: `Unknown alert source: ${kind}` });
  }
}
