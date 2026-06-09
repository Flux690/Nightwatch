import type { FastifyReply, FastifyRequest } from "fastify";

// Single-admin auth seam (D5). Phase 6 ships the gate's shape, not its teeth:
// there is no login flow yet, so when auth is disabled the gate passes through.
// Phase 7 adds the /setup + login wall that mints the session cookie this gate
// will validate, and flips the default to enforce.
//
// Disabled unless NIGHTWATCH_DISABLE_AUTH is explicitly "false". This keeps a
// fresh dev checkout working before Phase 7 lands; Phase 7 inverts the default.
const SESSION_COOKIE = "nw_session";

function authDisabled(): boolean {
  return process.env["NIGHTWATCH_DISABLE_AUTH"] !== "false";
}

function hasSessionCookie(request: FastifyRequest): boolean {
  const header = request.headers.cookie;
  if (!header) return false;
  return header
    .split(";")
    .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

// Fastify preHandler: attach to mutating routes via `{ preHandler: requireAuth }`.
// Phase 7 replaces the presence check with real session-token validation.
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (authDisabled()) return;
  if (hasSessionCookie(request)) return;
  await reply.code(401).send({ error: "authentication required" });
}
