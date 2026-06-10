import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { ensureAdminUser } from "../auth/admin.js";

// The single deployment token (D5: one token per operator, shared across all
// runners). Read-only and idempotent: returns the earliest-created token, or
// mints one if none exists yet, so the install command is available before any
// runner has connected. Rotation is out of scope - runners carry the token from
// install time and there is no push channel to re-key them.
export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/token", async () => {
    const existing = await db.token.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (existing) return { token: existing.token };

    const user = await ensureAdminUser();
    const created = await db.token.create({ data: { userId: user.id } });
    return { token: created.token };
  });
}
