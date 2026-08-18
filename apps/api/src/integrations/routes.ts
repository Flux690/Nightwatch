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
} from "../db/integrations.js";
import {
  deleteAlertSource,
  generateAlertSourceToken,
  getAlertSource,
} from "../db/alert-sources.js";
import { isAlertSourceKind } from "@nightwarden/shared";
import type { AlertSourceKind } from "@nightwarden/shared";
import {
  GitHubApiError,
  listRepos,
  ownerIsOrganization,
  validateRepoAccess,
} from "./github.js";
import { LokiApiError, probeLoki } from "./loki.js";
import { preflight } from "../sandbox/preflight.js";
import { teardownAll } from "../sandbox/workspace.js";
import { logger } from "../logger.js";
import { publicUrl } from "../env/public-url.js";
import type {
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
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

const ConnectBodySchema = z.object({
  token: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

const RebindBodySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

function statusPayload(): GitHubIntegrationStatus {
  const row = getGitHubIntegration();
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

function lokiStatusPayload(): LokiIntegrationStatus {
  const row = getLokiIntegration();
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

export async function registerIntegrationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Status only: the plaintext token is never returned by any endpoint - there
  // is no reveal use case; regenerate on GitHub via the deep link instead.
  fastify.get(
    "/integrations/github",
    { preHandler: requireSession },
    async () => statusPayload(),
  );

  // Sandbox prerequisites, checked when the user clicks Connect: fail
  // loud at setup time, never at 3am mid-incident.
  fastify.post(
    "/integrations/github/preflight",
    { preHandler: requireSession },
    async () => preflight(),
  );

  // During onboarding the token rides the body; afterwards the stored
  // credential is used. POST, never GET, so a token never lands in a URL.
  fastify.post(
    "/integrations/github/repos",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ReposBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const stored = getGitHubIntegration();
      const token = parsed.data.token ?? stored?.token ?? null;
      if (!token) {
        return reply
          .code(400)
          .send({ error: "No token provided and no integration configured" });
      }
      try {
        const { repos, hasMore } = await listRepos(
          token,
          parsed.data.page ?? 1,
        );
        return { repos, hasMore };
      } catch (err) {
        return sendGitHubError(reply, err);
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
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { token, repo } = parsed.data;
      // The body schema regex guarantees exactly one slash with both sides
      // non-empty, so the two-element destructure cannot miss.
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const validated = await validateRepoAccess(token, owner, name);
        saveGitHubIntegration({
          token,
          repoOwner: owner,
          repoName: name,
          tokenExpiresAt: validated.expiresAt,
        });
        logger.info({ repo }, "github integration configured");
        return await reply.code(201).send(statusPayload());
      } catch (err) {
        if (err instanceof GitHubApiError && err.code === "repo_not_found") {
          const orgApprovalUrl = (await ownerIsOrganization(owner))
            ? `https://github.com/organizations/${owner}/settings/personal-access-token-requests`
            : undefined;
          return reply.code(404).send({
            error: err.message,
            code: err.code,
            ...(orgApprovalUrl !== undefined && { orgApprovalUrl }),
          });
        }
        return sendGitHubError(reply, err);
      }
    },
  );

  // Never accepts a token - only ever uses the one already stored, so the
  // request proves nothing beyond "pick a different repo".
  fastify.patch(
    "/integrations/github",
    { preHandler: requireSession },
    async (request, reply) => {
      const stored = getGitHubIntegration();
      if (!stored) {
        return reply.code(400).send({ error: "GitHub is not connected" });
      }
      const parsed = RebindBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const [owner, name] = parsed.data.repo.split("/") as [string, string];
      try {
        const token = stored.token;
        await validateRepoAccess(token, owner, name);
        updateGitHubIntegrationRepo(owner, name);
        logger.info(
          { repo: parsed.data.repo },
          "github integration repository changed",
        );
        return await reply.code(200).send(statusPayload());
      } catch (err) {
        if (err instanceof GitHubApiError && err.code === "repo_not_found") {
          const orgApprovalUrl = (await ownerIsOrganization(owner))
            ? `https://github.com/organizations/${owner}/settings/personal-access-token-requests`
            : undefined;
          return reply.code(404).send({
            error: err.message,
            code: err.code,
            ...(orgApprovalUrl !== undefined && { orgApprovalUrl }),
          });
        }
        return sendGitHubError(reply, err);
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
      deleteGitHubIntegration();
      logger.info("github integration disconnected");
      return reply.code(204).send();
    },
  );

  fastify.get("/integrations/loki", { preHandler: requireSession }, async () =>
    lokiStatusPayload(),
  );

  // Connect: probe the labels endpoint before saving - it is cheap, exercises
  // auth AND the tenant header, and proves discovery will work; a bad URL,
  // credential, or tenant fails loud at setup, never at 3am mid-incident.
  fastify.post(
    "/integrations/loki",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = LokiConnectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { url, authHeader, orgId } = parsed.data;
      try {
        await probeLoki(url, authHeader ?? null, orgId ?? null);
        saveLokiIntegration({
          baseUrl: url,
          orgId: orgId ?? null,
          authorization: authHeader ?? null,
        });
        logger.info({ url }, "loki integration configured");
        return await reply.code(201).send(lokiStatusPayload());
      } catch (err) {
        return sendLokiError(reply, err);
      }
    },
  );

  fastify.delete(
    "/integrations/loki",
    { preHandler: requireSession },
    async (_request, reply) => {
      deleteLokiIntegration();
      logger.info("loki integration disconnected");
      return reply.code(204).send();
    },
  );

  // Credential minted here (the config plane); deliveries hit /alerts/ingest
  // (the data plane) with it. One family, so a new sender is a kind.
  const knownSender = [requireSession, requireKnownAlertSource];

  fastify.get<AlertSourceRoute>(
    "/integrations/alerting/:kind",
    { preHandler: knownSender },
    async (request) => {
      const source = getAlertSource(request.params.kind);
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
        .send({ token: generateAlertSourceToken(request.params.kind) }),
  );

  // Deleting the row is the revoke: the credential stops matching on the next
  // delivery, which is the only place it is ever checked.
  fastify.delete<AlertSourceRoute>(
    "/integrations/alerting/:kind",
    { preHandler: knownSender },
    async (request, reply) => {
      deleteAlertSource(request.params.kind);
      logger.info({ kind: request.params.kind }, "alert source disconnected");
      return reply.code(204).send();
    },
  );
}

/* The handlers below run only for a sender the build knows, so they read the
   kind as one. Guarded the way requireSession guards a caller's identity: the
   check is the route's precondition, not a branch inside every handler. */
interface AlertSourceRoute {
  Params: { kind: AlertSourceKind };
}

// Checked against the shared list, so the console and the API cannot disagree
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
