import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { mintSession, requireSession } from "../auth/session.js";

// All test servers honor X-Forwarded-Proto via trustProxy.
async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, trustProxy: true });
  await registerAuthRoutes(server);
  server.get("/protected", { preHandler: requireSession }, async () => ({
    ok: true,
  }));
  await server.ready();
  return server;
}

function setCookieHeader(res: {
  headers: { "set-cookie"?: string | string[] };
}): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header ?? "";
}

function extractSessionValue(setCookie: string): string {
  return /nw_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
}

// Setup and basic cookie attributes
describe("POST /setup", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("rejects password shorter than 12 characters", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "tooshort" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects password of exactly 11 characters", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "elevencharx" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates owner and sets session cookie for a 12+ character password", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/nw_session=[^;]+/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // Plain HTTP inject → no Secure flag
    expect(cookie).not.toContain("Secure");
  });

  it("rejects a second setup call with 409", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "other@example.com", password: "anotherpassword123" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("sets the Secure flag when X-Forwarded-Proto is https", async () => {
    // The owner was already created above; testing the Secure flag on /login
    // instead so we don't need a clean DB just for this attribute check.
    const loginRes = await server.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-proto": "https" },
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(setCookieHeader(loginRes)).toContain("Secure");
  });

  it("omits the Secure flag over plain HTTP", async () => {
    const loginRes = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(setCookieHeader(loginRes)).not.toContain("Secure");
  });
});

// Login behavior
describe("POST /login", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("sets nw_session cookie on correct credentials", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/nw_session=[^;]+/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("returns 401 for wrong password, generic error message", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "wrongpassword123" },
    });
    expect(res.statusCode).toBe(401);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "invalid credentials",
    );
  });

  it("returns 401 for unknown email, same generic error", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "nobody@example.com", password: "correcthorsebattery" },
    });
    expect(res.statusCode).toBe(401);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "invalid credentials",
    );
  });
});

// requireSession gate behavior
describe("requireSession gate", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    // Establish owner so session_epoch = 0 is in the DB
    await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 401 when no cookie is present", async () => {
    const res = await server.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 for a validly signed current cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${mintSession(0)}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 for a cookie with a tampered signature", async () => {
    const valid = mintSession(0);
    const tampered = valid.slice(0, -4) + "XXXX";
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an expired cookie", async () => {
    const { createHmac } = await import("node:crypto");
    const key = process.env["SECRET_KEY"] ?? "";
    const nowS = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      iat: nowS - 1000,
      exp: nowS - 1,
      epoch: 0,
    });
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const sig = createHmac("sha256", key)
      .update(payloadB64)
      .digest()
      .toString("base64url");
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${payloadB64}.${sig}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a cookie with epoch=1 when DB has epoch=0", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${mintSession(1)}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

// End-to-end: cookie from setup/login gate
describe("session cookie unlocks protected routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("cookie from /setup unlocks a protected route", async () => {
    const setupRes = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    const sessionValue = extractSessionValue(setCookieHeader(setupRes));
    const protectedRes = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${sessionValue}` },
    });
    expect(protectedRes.statusCode).toBe(200);
  });

  it("cookie from /login unlocks a protected route", async () => {
    const loginRes = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    const sessionValue = extractSessionValue(setCookieHeader(loginRes));
    const protectedRes = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${sessionValue}` },
    });
    expect(protectedRes.statusCode).toBe(200);
  });
});

// Logout
describe("POST /logout", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 200 with Max-Age=0 to clear the cookie", async () => {
    const res = await server.inject({ method: "POST", url: "/logout" });
    expect(res.statusCode).toBe(200);
    const header = setCookieHeader(res);
    expect(header).toContain("Max-Age=0");
  });

  it("is safe to call when unauthenticated", async () => {
    const res = await server.inject({ method: "POST", url: "/logout" });
    expect(res.statusCode).toBe(200);
  });

  it("protected route is 401 without a cookie (simulates client after logout)", async () => {
    const res = await server.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });
});

// Rolling reissue
describe("rolling session reissue", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("emits a fresh Set-Cookie when fewer than 2 days remain on the cookie", async () => {
    vi.useFakeTimers();
    const cookie = mintSession(0); // exp = now + 7 days
    vi.advanceTimersByTime((7 - 1.5) * 24 * 60 * 60 * 1000); // 1.5 days left
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${cookie}` },
    });
    vi.useRealTimers();
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)).toMatch(/nw_session=[^;]+/);
  });

  it("does not emit Set-Cookie when more than 2 days remain on the cookie", async () => {
    vi.useFakeTimers();
    const cookie = mintSession(0); // exp = now + 7 days
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000); // 4 days left
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${cookie}` },
    });
    vi.useRealTimers();
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)).toBe("");
  });
});

// Revoke all sessions
describe("POST /revoke-sessions", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let validCookie: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = await buildServer();
    const setupRes = await server.inject({
      method: "POST",
      url: "/setup",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    validCookie = extractSessionValue(setCookieHeader(setupRes));
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("returns 401 without a valid session", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/revoke-sessions",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 when called with a valid session", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/revoke-sessions",
      headers: { cookie: `nw_session=${validCookie}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("previously valid cookie is rejected after revoke", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${validCookie}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("fresh login works after revoke", async () => {
    const loginRes = await server.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "correcthorsebattery" },
    });
    expect(loginRes.statusCode).toBe(200);
    const newCookie = extractSessionValue(setCookieHeader(loginRes));
    const protectedRes = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: `nw_session=${newCookie}` },
    });
    expect(protectedRes.statusCode).toBe(200);
  });
});
