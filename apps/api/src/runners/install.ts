import type { FastifyInstance } from "fastify";
import type { Platform } from "@nightwarden/shared";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findRunnerByToken } from "../db/runner.js";
import { publicWsUrl } from "../env/public-url.js";
import { dockerInstallScript } from "./install-docker.js";
import { kubernetesInstallManifest } from "./install-kubernetes.js";

interface InstallArtifact {
  contentType: string;
  build: (wsUrl: string, token: string) => string;
}

// Total over Platform, so adding one is a compiler error here rather than a
// route that quietly serves the wrong artifact.
const ARTIFACT: Record<Platform, InstallArtifact> = {
  docker: {
    contentType: "text/x-shellscript",
    build: dockerInstallScript,
  },
  kubernetes: {
    contentType: "application/yaml; charset=utf-8",
    build: kubernetesInstallManifest,
  },
};

export async function registerInstallRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // One endpoint for both platforms: the row the token names decides which
  // artifact comes back, so the wrong one cannot be fetched for a runner.
  fastify.get(
    "/runners/install",
    { preHandler: requireSession },
    async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        return reply.code(400).send({
          error: "runner token required in Authorization: Bearer header",
        });
      }

      const record = findRunnerByToken(token);
      if (!record) {
        return reply.code(404).send({ error: "token not found" });
      }

      const artifact = ARTIFACT[record.platform];
      const body = artifact.build(
        publicWsUrl(request, "/api/clients/connect"),
        token,
      );

      reply.header("Content-Type", artifact.contentType);
      return reply.code(200).send(body);
    },
  );
}
