import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getSessionEpoch } from "../config/store.js";

const SESSION_COOKIE = "nw_session";
const SESSION_LIFETIME_S = 7 * 24 * 60 * 60;
const REISSUE_THRESHOLD_S = 2 * 24 * 60 * 60;

function hmacKey(): string {
  const key = process.env["SECRET_KEY"];
  if (!key) throw new Error("SECRET_KEY is not set");
  return key;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function setCookieHeader(value: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function mintSession(epoch: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iat: now,
    exp: now + SESSION_LIFETIME_S,
    epoch,
  });
  const payloadB64 = b64url(Buffer.from(payload));
  const sig = createHmac("sha256", hmacKey()).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

type Payload = { iat: number; exp: number; epoch: number };

function parseAndVerify(value: string): Payload | null {
  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;
  const payloadB64 = value.slice(0, dot);
  const sigB64 = value.slice(dot + 1);

  const expected = createHmac("sha256", hmacKey()).update(payloadB64).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    return JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as Payload;
  } catch {
    return null;
  }
}

function extractCookieValue(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${SESSION_COOKIE}=`))
      return t.slice(SESSION_COOKIE.length + 1);
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
  const payload = parseAndVerify(value);
  if (!payload) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }
  const storedEpoch = getSessionEpoch();
  const nowS = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowS || payload.epoch !== storedEpoch) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }
  if (payload.exp - nowS < REISSUE_THRESHOLD_S) {
    const secure = request.protocol === "https";
    reply.header(
      "Set-Cookie",
      setCookieHeader(mintSession(storedEpoch), secure),
    );
  }
}
