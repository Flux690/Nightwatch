import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireSession } from "../auth/session.js";
import { decrypt, encrypt } from "../config/crypto.js";
import {
  deleteGitHubIntegration,
  getGitHubIntegration,
  saveGitHubIntegration,
  updateGitHubIntegrationRepo,
} from "../db/github-integration.js";
import {
  GitHubApiError,
  listRepos,
  ownerIsOrganization,
  validateRepoAccess,
} from "./github.js";
import { preflight } from "../sandbox/preflight.js";
import { teardownAll } from "../sandbox/workspace.js";
import { logger } from "../logger.js";
import type { GitHubIntegrationStatus } from "@nightwatch/shared";

const ReposBodySchema = z.object({
  token: z.string().min(1).optional(),
  page: z.number().int().positive().optional(),
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

  // Sandbox prerequisites, checked when the operator clicks Connect: fail
  // loud at setup time, never at 3am mid-incident.
  fastify.post(
    "/integrations/github/preflight",
    { preHandler: requireSession },
    async () => preflight(),
  );

  // Picker proxy. During onboarding the token rides the body (nothing stored
  // yet); afterwards the stored credential is used. POST, never GET: a token
  // must not appear in a URL.
  fastify.post(
    "/integrations/github/repos",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ReposBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const stored = getGitHubIntegration();
      const token =
        parsed.data.token ?? (stored ? decrypt(stored.tokenEncrypted) : null);
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
          tokenEncrypted: encrypt(token),
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

  // Rebind: point the existing credential at a different repo. Never
  // accepts a token - it only ever uses the one already stored, so the
  // request itself proves nothing beyond "pick a different repo".
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
        const token = decrypt(stored.tokenEncrypted);
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

  // Disconnect deletes our stored copy only; full invalidation requires
  // revoking the token on GitHub, and the console says so plainly. Sandboxes
  // are torn down first, while the token still exists for a final push.
  fastify.delete(
    "/integrations/github",
    { preHandler: requireSession },
    async (_request, reply) => {
      await teardownAll("github integration disconnected");
      deleteGitHubIntegration();
      logger.info("github integration disconnected");
      return reply.code(204).send();
    },
  );
}
