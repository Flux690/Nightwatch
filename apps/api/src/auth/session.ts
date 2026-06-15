import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getLoginVersion } from "../config/store.js";

const AUTH_COOKIE = "nw_auth";
const SESSION_LIFETIME_S = 7 * 24 * 60 * 60;
const REISSUE_THRESHOLD_S = 2 * 24 * 60 * 60;

function signingKey(): Uint8Array {
  const key = process.env["SECRET_KEY"];
  if (!key) throw new Error("SECRET_KEY is not set");
  return new TextEncoder().encode(key);
}

export function cookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function mintSession(loginVersion: number): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  return new SignJWT({ loginVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + SESSION_LIFETIME_S)
    .sign(signingKey());
}

function extractCookieValue(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${AUTH_COOKIE}=`)) return t.slice(AUTH_COOKIE.length + 1);
  }
  return undefined;
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const value = extractCookieValue(request.headers.cookie);
  if (!value) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }

  let loginVersion: unknown;
  let exp: number;
  try {
    const { payload } = await jwtVerify(value, signingKey(), {
      algorithms: ["HS256"],
    });
    loginVersion = payload["loginVersion"];
    exp = payload.exp ?? 0;
  } catch {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }

  const storedVersion = getLoginVersion();
  if (loginVersion !== storedVersion) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (exp - nowS < REISSUE_THRESHOLD_S) {
    const secure = request.protocol === "https";
    reply.header(
      "Set-Cookie",
      cookieHeader(await mintSession(storedVersion), secure),
    );
  }
}
