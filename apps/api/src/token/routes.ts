import type { FastifyInstance } from "fastify";
import { createToken, oldestToken } from "../db/tokens.js";

// The single deployment token (D5: one token per operator, shared across all
// runners). Read-only and idempotent: returns the earliest-created token, or
// mints one if none exists yet, so the install command is available before any
// runner has connected. Rotation is out of scope here - runners carry the token
// from install time and there is no push channel to re-key them.
export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/token", async () => {
    const existing = oldestToken();
    if (existing) return { token: existing.token };
    return { token: createToken().token };
  });
}
