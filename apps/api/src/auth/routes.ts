import { hash, verify } from "argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { mintSession } from "./session.js";
import {
  getOwnerCredentials,
  getSessionEpoch,
  saveOwner,
} from "../config/store.js";

const MIN_PASSWORD = 12;

function setCookieHeader(value: string, secure: boolean): string {
  const parts = [`nw_session=${value}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function isHttps(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

export async function registerAuthRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const dummyHash = await hash("nightwatch-dummy-placeholder");

  fastify.post<{ Body: { email?: string; password?: string } }>(
    "/setup",
    async (request, reply) => {
      if (getOwnerCredentials()) {
        return reply.code(409).send({ error: "setup already complete" });
      }
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply
          .code(400)
          .send({ error: "email and password are required" });
      }
      if (password.length < MIN_PASSWORD) {
        return reply
          .code(400)
          .send({ error: "password must be at least 12 characters" });
      }
      const ownerHash = await hash(password);
      saveOwner(email, ownerHash);
      const cookie = mintSession(getSessionEpoch());
      reply.header("Set-Cookie", setCookieHeader(cookie, isHttps(request)));
      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post<{ Body: { email?: string; password?: string } }>(
    "/login",
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      const owner = getOwnerCredentials();
      const hashToVerify = owner?.hash ?? dummyHash;
      const valid = await verify(hashToVerify, password ?? "");
      if (!owner || owner.email !== email || !valid) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      const cookie = mintSession(getSessionEpoch());
      reply.header("Set-Cookie", setCookieHeader(cookie, isHttps(request)));
      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post("/logout", async (_request, reply) => {
    reply.header(
      "Set-Cookie",
      "nw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return reply.code(200).send({ ok: true });
  });
}
