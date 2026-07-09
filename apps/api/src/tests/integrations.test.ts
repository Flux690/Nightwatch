import "dotenv/config";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { registerIntegrationRoutes } from "../integrations/routes.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db/client.js";
import { decrypt } from "../config/crypto.js";

const TOKEN = "github_pat_test_plaintext";

const REPO_FIXTURE = [
  {
    full_name: "acme/api",
    private: true,
    pushed_at: "2026-07-01T00:00:00Z",
    owner: { type: "Organization" },
  },
  {
    full_name: "prabhat/dotfiles",
    private: false,
    pushed_at: "2026-06-01T00:00:00Z",
    owner: { type: "User" },
  },
];

const EXPIRY_HEADER = "2026-10-06 12:00:00 UTC";
const EXPIRY_ISO = "2026-10-06T12:00:00.000Z";

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchMock {
  const mock = vi.fn<typeof fetch>(async (input, init) =>
    impl(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("GitHub integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await registerIntegrationRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Return type inferred: fastify's inject() overloads resolve to the
  // promise form only when called with options and no callback.
  function authed(opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }) {
    return server.inject({
      method: opts.method,
      url: opts.url,
      ...(opts.payload !== undefined && { payload: opts.payload }),
      headers: { cookie: `nw_auth=${SESSION}` },
    });
  }

  describe("GET /integrations/github", () => {
    it("reports not configured before onboarding", async () => {
      const res = await authed({ method: "GET", url: "/integrations/github" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        configured: false,
        repo: null,
        expiresAt: null,
        validatedAt: null,
      });
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/integrations/github",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /integrations/github (rebind repo) before onboarding", () => {
    it("rejects rebinding when nothing is configured yet", async () => {
      const res = await authed({
        method: "PATCH",
        url: "/integrations/github",
        payload: { repo: "acme/api" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /integrations/github/repos (picker proxy)", () => {
    it("returns the granted repos normalized, with pagination and no token in any URL", async () => {
      const mock = stubFetch((url) => {
        expect(url).not.toContain(TOKEN);
        return jsonResponse(REPO_FIXTURE, {
          headers: {
            link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"',
            "github-authentication-token-expiration": EXPIRY_HEADER,
          },
        });
      });

      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: { token: TOKEN, page: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        repos: [
          {
            fullName: "acme/api",
            private: true,
            pushedAt: "2026-07-01T00:00:00Z",
            ownerIsOrg: true,
          },
          {
            fullName: "prabhat/dotfiles",
            private: false,
            pushedAt: "2026-06-01T00:00:00Z",
            ownerIsOrg: false,
          },
        ],
        hasMore: true,
      });

      const [calledUrl, calledInit] = mock.mock.calls[0] ?? [];
      expect(String(calledUrl)).toContain("/user/repos?per_page=100&page=1");
      const headers = (calledInit?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("maps 401 to the invalid_token ladder step", async () => {
      stubFetch(() =>
        jsonResponse({ message: "Bad credentials" }, { status: 401 }),
      );
      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: { token: TOKEN },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ code: "invalid_token" });
    });

    it("maps 403-with-SSO-header to sso_required", async () => {
      stubFetch(() =>
        jsonResponse(
          { message: "Resource protected by organization SAML enforcement" },
          {
            status: 403,
            headers: { "x-github-sso": "required; url=https://example" },
          },
        ),
      );
      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: { token: TOKEN },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ code: "sso_required" });
    });

    it("maps an unreachable GitHub to 502 network", async () => {
      stubFetch(() => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      });
      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: { token: TOKEN },
      });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body)).toMatchObject({ code: "network" });
    });

    it("rejects when no token is supplied and none is stored", async () => {
      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /integrations/github (bind repo)", () => {
    it("validates the repo, stores the token encrypted, and captures expiry", async () => {
      stubFetch((url) => {
        expect(url).toContain("/repos/acme/api");
        return jsonResponse(
          { full_name: "acme/api" },
          {
            headers: {
              "github-authentication-token-expiration": EXPIRY_HEADER,
            },
          },
        );
      });

      const res = await authed({
        method: "POST",
        url: "/integrations/github",
        payload: { token: TOKEN, repo: "acme/api" },
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({
        configured: true,
        repo: "acme/api",
        expiresAt: EXPIRY_ISO,
      });

      const row = getDb()
        .prepare(
          "SELECT token_encrypted FROM github_integration WHERE id = 'github'",
        )
        .get() as { token_encrypted: string };
      expect(row.token_encrypted).not.toContain(TOKEN);
      expect(decrypt(row.token_encrypted)).toBe(TOKEN);
    });

    it("uses the stored token for the picker proxy after binding", async () => {
      const mock = stubFetch(() => jsonResponse([]));
      const res = await authed({
        method: "POST",
        url: "/integrations/github/repos",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const [, calledInit] = mock.mock.calls[0] ?? [];
      const headers = (calledInit?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("adds the org-approval link on 404 when the owner is an organization", async () => {
      stubFetch((url) => {
        if (url.includes("/repos/acme/secret")) {
          return jsonResponse({ message: "Not Found" }, { status: 404 });
        }
        expect(url).toContain("/users/acme");
        return jsonResponse({ type: "Organization" });
      });
      const res = await authed({
        method: "POST",
        url: "/integrations/github",
        payload: { token: TOKEN, repo: "acme/secret" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "repo_not_found",
        orgApprovalUrl:
          "https://github.com/organizations/acme/settings/personal-access-token-requests",
      });
    });

    it("omits the org-approval link on 404 when the owner is a user", async () => {
      stubFetch((url) => {
        if (url.includes("/repos/prabhat/gone")) {
          return jsonResponse({ message: "Not Found" }, { status: 404 });
        }
        return jsonResponse({ type: "User" });
      });
      const res = await authed({
        method: "POST",
        url: "/integrations/github",
        payload: { token: TOKEN, repo: "prabhat/gone" },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body["code"]).toBe("repo_not_found");
      expect(body).not.toHaveProperty("orgApprovalUrl");
    });

    it("rejects a malformed owner/repo string without calling GitHub", async () => {
      const mock = stubFetch(() => jsonResponse({}));
      const res = await authed({
        method: "POST",
        url: "/integrations/github",
        payload: { token: TOKEN, repo: "not-a-repo" },
      });
      expect(res.statusCode).toBe(400);
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /integrations/github (rebind repo)", () => {
    it("rebinds to a different granted repo without a token in the request body", async () => {
      const mock = stubFetch((url) => {
        expect(url).toContain("/repos/acme/other");
        return jsonResponse({ full_name: "acme/other" });
      });

      const res = await authed({
        method: "PATCH",
        url: "/integrations/github",
        payload: { repo: "acme/other" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        configured: true,
        repo: "acme/other",
      });

      const [, calledInit] = mock.mock.calls[0] ?? [];
      const headers = (calledInit?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);

      const row = getDb()
        .prepare(
          "SELECT token_encrypted FROM github_integration WHERE id = 'github'",
        )
        .get() as { token_encrypted: string };
      expect(decrypt(row.token_encrypted)).toBe(TOKEN);
    });

    it("surfaces repo_not_found the same way bind does, without accepting a token", async () => {
      stubFetch((url) => {
        if (url.includes("/repos/acme/missing")) {
          return jsonResponse({ message: "Not Found" }, { status: 404 });
        }
        return jsonResponse({ type: "Organization" });
      });
      const res = await authed({
        method: "PATCH",
        url: "/integrations/github",
        payload: { repo: "acme/missing", token: "ignored" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: "repo_not_found" });
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "PATCH",
        url: "/integrations/github",
        payload: { repo: "acme/other" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("DELETE /integrations/github", () => {
    it("disconnects: deletes the stored row and reports not configured", async () => {
      const res = await authed({
        method: "DELETE",
        url: "/integrations/github",
      });
      expect(res.statusCode).toBe(204);

      const status = await authed({
        method: "GET",
        url: "/integrations/github",
      });
      expect(JSON.parse(status.body)).toMatchObject({ configured: false });
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "DELETE",
        url: "/integrations/github",
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
