import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { loadConfig, updateConfig } from "./store.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";

// Only these fields are user-editable; secrets are never part of the surface.
const ConfigPatchSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(["adaptive", "off"]).optional(),
  structuredOutput: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  hardTimeoutMs: z.number().int().positive().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
});

export async function registerConfigRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/config", async () => loadConfig());

  fastify.patch(
    "/config",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = ConfigPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const updated = await updateConfig(parsed.data);
      logger.info({ keys: Object.keys(parsed.data) }, "agent config updated");
      return updated;
    },
  );
}
