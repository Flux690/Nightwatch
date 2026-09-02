import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AuthStatusResponse } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { requireSession } from "../auth/session.js";
import { mountApi } from "./api-server.js";

const OWNER = {
  email: "admin@example.com",
  password: "correcthorsebattery",
  name: "Admin",
};

async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, trustProxy: true });
  await mountApi(server, registerAuthRoutes);
  server.get("/protected", { preHandler: requireSession }, async () => ({
    ok: true,
  }));
  await server.ready();
  return server;
}

function signUp(server: FastifyInstance, payload: Record<string, string>) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload,
  });
}

function signIn(
  server: FastifyInstance,
  payload: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return server.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload,
    headers,
  });
}

// The Set-Cookie values as a Cookie request header, which is what a browser
// sends back and what every authenticated call here needs.
function cookieFrom(res: { headers: { "set-cookie"?: string | string[] } }) {
  const raw = res.headers["set-cookie"] ?? [];
  const all = Array.isArray(raw) ? raw : [raw];
  return all.map((c) => c.split(";")[0]).join("; ");
}

function status(server: FastifyInstance, cookie?: string) {
  return server.inject({
    method: "GET",
    url: "/api/auth-status",
    ...(cookie !== undefined && { headers: { cookie } }),
  });
}

describe("the first account", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("creates the owner and sets a session cookie", async () => {
    const res = await signUp(server, OWNER);
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).not.toBe("");
  });

  // The install has one owner and everyone after arrives by invitation, so the
  // signup door closes the moment it has been used.
  it("refuses a second account", async () => {
    const res = await signUp(server, {
      email: "other@example.com",
      password: "anotherpassword123",
      name: "Other",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await status(server);
    expect(JSON.parse(after.body)).toMatchObject({ ownerExists: true });
  });

  it("makes that first account an admin", async () => {
    const res = await signIn(server, OWNER);
    const session = JSON.parse(res.body) as { user?: { role?: string } };
    expect(session.user?.role).toBe("admin");
  });

  /* An admin adding a colleague is not self-registration, so the rule that
     closes the door must not close it on them - which is how invitations work. */
  it("lets an admin create an account once the door is shut", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/admin/create-user",
      headers: { cookie },
      payload: {
        email: "colleague@example.com",
        password: "another-long-password",
        name: "Colleague",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  // The role stamp belongs to the first account alone.
  it("leaves an admin-created account off the admin role", async () => {
    const cookie = cookieFrom(await signIn(server, OWNER));
    const res = await server.inject({
      method: "GET",
      url: "/api/auth/admin/list-users?limit=10",
      headers: { cookie },
    });
    const { users } = JSON.parse(res.body) as {
      users: Array<{ email: string; role: string | null }>;
    };
    const colleague = users.find((u) => u.email === "colleague@example.com");
    expect(colleague?.role).toBe("user");
  });
});

describe("GET /auth-status", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("reports no owner before setup", async () => {
    const res = await status(server);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ownerExists: false });
  });

  it("reports an owner but no session once one exists", async () => {
    await signUp(server, OWNER);
    const res = await status(server);
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });

  it("reports no session for a garbage cookie", async () => {
    const res = await status(server, "better-auth.session_token=garbage");
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });

  it("reports the signed-in email and name for a valid cookie", async () => {
    const signedIn = await signIn(server, OWNER);
    const res = await status(server, cookieFrom(signedIn));
    expect(JSON.parse(res.body) as AuthStatusResponse).toEqual({
      ownerExists: true,
      authenticated: true,
      email: OWNER.email,
      name: OWNER.name,
    });
  });

  /* The session is a row, not a signature, so revoking it stops the cookie
     working immediately rather than waiting for it to expire. */
  it("reports no session for a cookie whose row was revoked", async () => {
    const signedIn = await signIn(server, OWNER);
    const cookie = cookieFrom(signedIn);

    const revoked = await server.inject({
      method: "POST",
      url: "/api/auth/revoke-sessions",
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);

    const res = await status(server, cookie);
    expect(JSON.parse(res.body)).toEqual({
      ownerExists: true,
      authenticated: false,
    });
  });
});

describe("signing in", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
    await signUp(server, OWNER);
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("sets a session cookie on the right credentials", async () => {
    const res = await signIn(server, OWNER);
    expect(res.statusCode).toBe(200);
    expect(cookieFrom(res)).not.toBe("");
  });
});

describe("requireSession gate", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let cookie: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    server = await buildServer();
    cookie = cookieFrom(await signUp(server, OWNER));
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  it("lets a valid cookie through", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a tampered cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie: cookie.slice(0, -4) + "XXXX" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a request with no cookie", async () => {
    const res = await server.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });
});
