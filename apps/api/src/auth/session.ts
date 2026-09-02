import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getAuth } from "./instance.js";

export interface SignedInUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

// Validated against the auth_session row rather than a signature alone, so a
// revoked device stops working the moment its row is deleted.
export async function currentUser(
  request: FastifyRequest,
): Promise<SignedInUser | null> {
  const session = await getAuth().api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) return null;
  const { id, email, name, role } = session.user;
  return { id, email, name, role: typeof role === "string" ? role : null };
}

export async function isAuthenticated(
  request: FastifyRequest,
): Promise<boolean> {
  return (await currentUser(request)) !== null;
}

// The preHandler every authenticated route already names, so replacing what
// backs it moved no call site.
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (await isAuthenticated(request)) return;
  await reply.code(401).send({ error: "authentication required" });
}
