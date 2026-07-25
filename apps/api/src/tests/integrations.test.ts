import { createHash } from "node:crypto";
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
import {
  deletePrometheusIntegration,
  deleteLokiIntegration,
} from "../db/integrations.js";
import { setAlertSourceReceived } from "../db/alert-sources.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { manifest } from "./manifest-helper.js";
import { getDb } from "../db/client.js";
import { decrypt } from "../config/crypto.js";
import { mountApi } from "./api-server.js";

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
    await mountApi(server, registerIntegrationRoutes);
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
      const res = await authed({
        method: "GET",
        url: "/api/integrations/github",
      });
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
        url: "/api/integrations/github",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /integrations/github (rebind repo) before onboarding", () => {
    it("rejects rebinding when nothing is configured yet", async () => {
      const res = await authed({
        method: "PATCH",
        url: "/api/integrations/github",
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
        url: "/api/integrations/github/repos",
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
        url: "/api/integrations/github/repos",
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
        url: "/api/integrations/github/repos",
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
        url: "/api/integrations/github/repos",
        payload: { token: TOKEN },
      });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body)).toMatchObject({ code: "network" });
    });

    it("rejects when no token is supplied and none is stored", async () => {
      const res = await authed({
        method: "POST",
        url: "/api/integrations/github/repos",
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
        url: "/api/integrations/github",
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
          "SELECT secret_encrypted FROM integrations WHERE kind = 'github'",
        )
        .get() as { secret_encrypted: string };
      expect(row.secret_encrypted).not.toContain(TOKEN);
      expect(decrypt(row.secret_encrypted)).toBe(TOKEN);
    });

    it("uses the stored token for the picker proxy after binding", async () => {
      const mock = stubFetch(() => jsonResponse([]));
      const res = await authed({
        method: "POST",
        url: "/api/integrations/github/repos",
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
        url: "/api/integrations/github",
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
        url: "/api/integrations/github",
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
        url: "/api/integrations/github",
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
        url: "/api/integrations/github",
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
          "SELECT secret_encrypted FROM integrations WHERE kind = 'github'",
        )
        .get() as { secret_encrypted: string };
      expect(decrypt(row.secret_encrypted)).toBe(TOKEN);
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
        url: "/api/integrations/github",
        payload: { repo: "acme/missing", token: "ignored" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: "repo_not_found" });
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/integrations/github",
        payload: { repo: "acme/other" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("DELETE /integrations/github", () => {
    it("disconnects: deletes the stored row and reports not configured", async () => {
      const res = await authed({
        method: "DELETE",
        url: "/api/integrations/github",
      });
      expect(res.statusCode).toBe(204);

      const status = await authed({
        method: "GET",
        url: "/api/integrations/github",
      });
      expect(JSON.parse(status.body)).toMatchObject({ configured: false });
    });

    it("requires a session", async () => {
      const res = await server.inject({
        method: "DELETE",
        url: "/api/integrations/github",
      });
      expect(res.statusCode).toBe(401);
    });
  });
});

describe("Prometheus integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  const PROM_OK = {
    status: "success",
    data: { resultType: "vector", result: [] },
  };

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerIntegrationRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    deletePrometheusIntegration();
  });

  function authed(opts: {
    method: "GET" | "POST" | "DELETE";
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

  it("reports not configured before onboarding and requires a session", async () => {
    const unauthed = await server.inject({
      method: "GET",
      url: "/api/integrations/prometheus",
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await authed({
      method: "GET",
      url: "/api/integrations/prometheus",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: false,
      url: null,
      hasAuth: false,
      validatedAt: null,
    });
  });

  it("connects after a successful probe: slash-tolerant URL, form body, verbatim auth, encrypted storage", async () => {
    const mock = stubFetch((url, init) => {
      expect(url).toBe("http://prom.internal:9090/api/v1/query");
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("query=up");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer secret-123",
      );
      return jsonResponse(PROM_OK);
    });

    const res = await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: {
        url: "http://prom.internal:9090/",
        authHeader: "Bearer secret-123",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      url: "http://prom.internal:9090/",
      hasAuth: true,
      validatedAt: expect.any(String),
    });
    expect(mock).toHaveBeenCalledTimes(1);

    const row = getDb()
      .prepare(
        "SELECT secret_encrypted FROM integrations WHERE kind = 'prometheus'",
      )
      .get() as { secret_encrypted: string };
    expect(decrypt(row.secret_encrypted)).toBe("Bearer secret-123");
    expect(row.secret_encrypted).not.toContain("secret-123");
  });

  it("connects without an auth header, sending none and reporting hasAuth: false", async () => {
    stubFetch((_url, init) => {
      expect(
        (init?.headers as Record<string, string>)["Authorization"],
      ).toBeUndefined();
      return jsonResponse(PROM_OK);
    });

    const res = await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: { url: "http://prom.internal:9090" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      configured: true,
      hasAuth: false,
    });
  });

  it("refuses to save when the probe fails - envelope error maps to 400, unreachable to 502", async () => {
    stubFetch(() =>
      jsonResponse(
        { status: "error", errorType: "bad_data", error: "unknown function" },
        { status: 400 },
      ),
    );
    const badQuery = await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: { url: "http://prom.internal:9090" },
    });
    expect(badQuery.statusCode).toBe(400);
    expect(JSON.parse(badQuery.body).code).toBe("bad_query");

    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const unreachable = await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: { url: "http://prom.internal:9090" },
    });
    expect(unreachable.statusCode).toBe(502);
    expect(JSON.parse(unreachable.body).code).toBe("network");

    const status = await authed({
      method: "GET",
      url: "/api/integrations/prometheus",
    });
    expect(JSON.parse(status.body).configured).toBe(false);
  });

  it("test endpoint is 400 unconfigured, then re-probes the stored config with the decrypted header", async () => {
    const before = await authed({
      method: "POST",
      url: "/api/integrations/prometheus/test",
    });
    expect(before.statusCode).toBe(400);

    stubFetch(() => jsonResponse(PROM_OK));
    await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: {
        url: "http://prom.internal:9090",
        authHeader: "Basic dXNlcg==",
      },
    });

    const mock = stubFetch((url, init) => {
      expect(url).toBe("http://prom.internal:9090/api/v1/query");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Basic dXNlcg==",
      );
      return jsonResponse(PROM_OK);
    });
    const res = await authed({
      method: "POST",
      url: "/api/integrations/prometheus/test",
    });
    expect(res.statusCode).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("validate-labels compares observed nw_server values against the fleet", async () => {
    const before = await authed({
      method: "POST",
      url: "/api/integrations/prometheus/validate-labels",
    });
    expect(before.statusCode).toBe(400);

    stubFetch((url) => {
      if (url.includes("/api/v1/label/nw_server/values")) {
        return jsonResponse({
          status: "success",
          data: ["host-a", "prod-web-99"],
        });
      }
      return jsonResponse(PROM_OK);
    });
    await authed({
      method: "POST",
      url: "/api/integrations/prometheus",
      payload: { url: "http://prom.internal:9090" },
    });

    const connA = registerRunner(
      "prom-validate-a",
      () => {},
      () => {},
    );
    setRunnerManifest("prom-validate-a", manifest("host-a"));
    const connB = registerRunner(
      "prom-validate-b",
      () => {},
      () => {},
    );
    setRunnerManifest("prom-validate-b", manifest("host-b"));

    try {
      const res = await authed({
        method: "POST",
        url: "/api/integrations/prometheus/validate-labels",
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        observed: ["host-a", "prod-web-99"],
        matched: ["host-a"],
        missing: ["host-b"],
        unknown: ["prod-web-99"],
      });
    } finally {
      unregisterRunner(connA);
      unregisterRunner(connB);
    }
  });
});

describe("Alertmanager integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerIntegrationRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  function authed(opts: { method: "GET" | "POST"; url: string }) {
    return server.inject({
      method: opts.method,
      url: opts.url,
      headers: { cookie: `nw_auth=${SESSION}` },
    });
  }

  function sha256hex(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  it("reports not configured with the ingest URL; reveal 404s; a session is required", async () => {
    const unauthed = await server.inject({
      method: "GET",
      url: "/api/integrations/alertmanager",
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await authed({
      method: "GET",
      url: "/api/integrations/alertmanager",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.ingestUrl).toMatch(/\/alerts\/ingest$/);
    expect(body.lastReceivedAt).toBeNull();

    const reveal = await authed({
      method: "POST",
      url: "/api/integrations/alertmanager/credential/reveal",
    });
    expect(reveal.statusCode).toBe(404);
  });

  it("mints an nwi_ credential storing only the hash; reveal returns the plaintext", async () => {
    const res = await authed({
      method: "POST",
      url: "/api/integrations/alertmanager/credential",
    });
    expect(res.statusCode).toBe(201);
    const { token } = JSON.parse(res.body) as { token: string };
    expect(token).toMatch(/^nwi_[A-Za-z0-9_-]{43}$/);

    const row = getDb()
      .prepare(
        "SELECT token_hash FROM alert_sources WHERE kind = 'alertmanager'",
      )
      .get() as { token_hash: string };
    expect(row.token_hash).toBe(sha256hex(token));
    expect(row.token_hash).not.toContain("nwi_");

    const reveal = await authed({
      method: "POST",
      url: "/api/integrations/alertmanager/credential/reveal",
    });
    expect(JSON.parse(reveal.body)).toEqual({ token });

    const status = await authed({
      method: "GET",
      url: "/api/integrations/alertmanager",
    });
    expect(JSON.parse(status.body)).toMatchObject({ configured: true });
  });

  it("rotation replaces the hash and resets the delivery stamp", async () => {
    const first = await authed({
      method: "POST",
      url: "/api/integrations/alertmanager/credential",
    });
    const { token: oldToken } = JSON.parse(first.body) as { token: string };
    setAlertSourceReceived("alertmanager", "2026-07-18T03:12:00.000Z");

    const before = await authed({
      method: "GET",
      url: "/api/integrations/alertmanager",
    });
    expect(
      (JSON.parse(before.body) as { lastReceivedAt: string | null })
        .lastReceivedAt,
    ).toBe("2026-07-18T03:12:00.000Z");

    const second = await authed({
      method: "POST",
      url: "/api/integrations/alertmanager/credential",
    });
    const { token: newToken } = JSON.parse(second.body) as { token: string };
    expect(newToken).not.toBe(oldToken);

    const row = getDb()
      .prepare(
        "SELECT token_hash, last_received_at FROM alert_sources WHERE kind = 'alertmanager'",
      )
      .get() as { token_hash: string; last_received_at: string | null };
    expect(row.token_hash).toBe(sha256hex(newToken));
    expect(row.token_hash).not.toBe(sha256hex(oldToken));
    expect(row.last_received_at).toBeNull();
  });
});

describe("Loki integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  const LOKI_LABELS = { status: "success", data: ["app", "namespace"] };

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerIntegrationRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    deleteLokiIntegration();
  });

  function authed(opts: {
    method: "GET" | "POST" | "DELETE";
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

  it("reports not configured before onboarding and requires a session", async () => {
    const unauthed = await server.inject({
      method: "GET",
      url: "/api/integrations/loki",
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await authed({ method: "GET", url: "/api/integrations/loki" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: false,
      url: null,
      hasAuth: false,
      hasOrgId: false,
      validatedAt: null,
    });
  });

  it("connects after a labels probe: verbatim auth, tenant header, encrypted storage", async () => {
    const mock = stubFetch((url, init) => {
      expect(url).toContain("/loki/api/v1/labels");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-123");
      expect(headers["X-Scope-OrgID"]).toBe("team-a");
      return jsonResponse(LOKI_LABELS);
    });

    const res = await authed({
      method: "POST",
      url: "/api/integrations/loki",
      payload: {
        url: "http://loki.internal:3100/",
        authHeader: "Bearer secret-123",
        orgId: "team-a",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      url: "http://loki.internal:3100/",
      hasAuth: true,
      hasOrgId: true,
      validatedAt: expect.any(String),
    });
    // The probe URL must not carry the credential.
    expect(String(mock.mock.calls[0]?.[0])).not.toContain("secret-123");

    const row = getDb()
      .prepare(
        "SELECT config, secret_encrypted FROM integrations WHERE kind = 'loki'",
      )
      .get() as { config: string; secret_encrypted: string };
    expect(decrypt(row.secret_encrypted)).toBe("Bearer secret-123");
    expect(row.secret_encrypted).not.toContain("secret-123");
    expect(JSON.parse(row.config)).toEqual({
      baseUrl: "http://loki.internal:3100/",
      orgId: "team-a",
    });
  });

  it("connects without auth or tenant, sending neither header", async () => {
    stubFetch((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["X-Scope-OrgID"]).toBeUndefined();
      return jsonResponse(LOKI_LABELS);
    });

    const res = await authed({
      method: "POST",
      url: "/api/integrations/loki",
      payload: { url: "http://loki.internal:3100" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      configured: true,
      hasAuth: false,
      hasOrgId: false,
    });
  });

  it("refuses to save when the probe fails - unreachable to 502, rejected credential to 401", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const unreachable = await authed({
      method: "POST",
      url: "/api/integrations/loki",
      payload: { url: "http://loki.internal:3100" },
    });
    expect(unreachable.statusCode).toBe(502);
    expect(JSON.parse(unreachable.body).code).toBe("network");

    stubFetch(() => jsonResponse({ message: "no org id" }, { status: 401 }));
    const unauthorized = await authed({
      method: "POST",
      url: "/api/integrations/loki",
      payload: { url: "http://loki.internal:3100" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(JSON.parse(unauthorized.body).code).toBe("unauthorized");

    const status = await authed({
      method: "GET",
      url: "/api/integrations/loki",
    });
    expect(JSON.parse(status.body).configured).toBe(false);
  });

  it("test endpoint is 400 unconfigured, then re-probes stored config with header + tenant", async () => {
    const before = await authed({
      method: "POST",
      url: "/api/integrations/loki/test",
    });
    expect(before.statusCode).toBe(400);

    stubFetch(() => jsonResponse(LOKI_LABELS));
    await authed({
      method: "POST",
      url: "/api/integrations/loki",
      payload: {
        url: "http://loki.internal:3100",
        authHeader: "Basic dXNlcg==",
        orgId: "team-b",
      },
    });

    const mock = stubFetch((url, init) => {
      expect(url).toContain("/loki/api/v1/labels");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Basic dXNlcg==");
      expect(headers["X-Scope-OrgID"]).toBe("team-b");
      return jsonResponse(LOKI_LABELS);
    });
    const res = await authed({
      method: "POST",
      url: "/api/integrations/loki/test",
    });
    expect(res.statusCode).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
