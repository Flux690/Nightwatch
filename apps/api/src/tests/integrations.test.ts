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
import { registerMetricsRoutes } from "../integrations/metrics/routes.js";
import {
  deleteLokiIntegration,
  deleteSentryIntegration,
} from "../integrations/store.js";
import { setAlertSourceReceived } from "../integrations/alert-sources.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { getDb } from "../db.js";
import { decrypt } from "../secrets.js";
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

/* The secret column holds one encrypted value whose plaintext is a map, so a
   test reads the key it wrote rather than the column. */
async function rawSecrets(kind: string): Promise<string> {
  const row = await getDb()
    .selectFrom("integrations")
    .select("secrets")
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row?.secrets ?? "";
}

async function storedSecret(
  kind: string,
  key: string,
): Promise<string | undefined> {
  const raw = await rawSecrets(kind);
  if (raw === "") return undefined;
  return (JSON.parse(decrypt(raw)) as Record<string, string>)[key];
}

describe("GitHub integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
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

      expect(await rawSecrets("github")).not.toContain(TOKEN);
      expect(await storedSecret("github", "token")).toBe(TOKEN);
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

      expect(await storedSecret("github", "token")).toBe(TOKEN);
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
  });
});

// The success envelope a Prometheus-compatible source answers a probe with.
const PROM_OK = {
  status: "success",
  data: { resultType: "vector", result: [] },
};

describe("metrics source routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerMetricsRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await getDb().deleteFrom("integrations").execute();
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

  it("lists nothing before onboarding and requires a session", async () => {
    const unauthed = await server.inject({
      method: "GET",
      url: "/api/integrations/metrics",
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await authed({
      method: "GET",
      url: "/api/integrations/metrics",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      configured: false,
      kind: null,
      query: null,
    });
  });

  it("probes both endpoints before saving, since a rules URL that answers nothing is the failure this exists to prevent", async () => {
    const asked: string[] = [];
    const mock = stubFetch((url) => {
      asked.push(url);
      return jsonResponse(
        url.includes("/rules")
          ? { status: "success", data: { groups: [] } }
          : PROM_OK,
      );
    });

    const res = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: {
        kind: "victoriametrics",
        query: { url: "http://vmselect:8481/select/0/prometheus" },
        rules: { url: "http://vmalert:8880" },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(asked).toEqual([
      "http://vmselect:8481/select/0/prometheus/api/v1/query",
      "http://vmalert:8880/api/v1/rules?type=alert",
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body)).toMatchObject({
      kind: "victoriametrics",
      // Derived from the product rather than asked for.
      label: "VictoriaMetrics",
      query: { url: "http://vmselect:8481/select/0/prometheus" },
      rules: { url: "http://vmalert:8880" },
    });
  });

  /* Grafana Cloud hands out an instance id and a token, never a base64 blob, so
     the pair is encoded here and stored as the one credential everything else
     reads. */
  it("encodes a basic pair into one Authorization header and never stores the parts", async () => {
    let sawAuth: string | undefined;
    stubFetch((_url, init) => {
      sawAuth = (init?.headers as Record<string, string>)["Authorization"];
      return jsonResponse(PROM_OK);
    });

    await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: {
        kind: "mimir",
        query: {
          url: "https://prometheus-prod-01.grafana.net/api/prom",
          basicUsername: "123456",
          basicPassword: "glc-token",
        },
      },
    });

    const expected = `Basic ${Buffer.from("123456:glc-token", "utf8").toString("base64")}`;
    expect(sawAuth).toBe(expected);
    expect(await storedSecret("mimir", "query")).toBe(expected);
    expect(await rawSecrets("mimir")).not.toContain("glc-token");
  });

  // AMP signs every request instead of carrying a header, so the probe itself
  // must arrive signed - checked on the real Request the client sends.
  it("signs an AMP probe with SigV4 instead of a static header", async () => {
    let seen: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen = input as Request;
        return jsonResponse(PROM_OK);
      }),
    );

    await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: {
        kind: "amp",
        query: {
          url: "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-test",
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          region: "us-east-1",
        },
      },
    });

    expect(seen?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/aps\/aws4_request/,
    );
    expect(await storedSecret("amp", "query")).toContain("AKIDEXAMPLE");
    expect(await rawSecrets("amp")).not.toContain("wJalrXUtnFEMI");
  });

  /* A legitimate configuration, not an error - and the one the frontend has to
     say out loud, because without it recovery can never be confirmed. */
  it("accepts a source with no rules endpoint and reports the gap as null", async () => {
    stubFetch(() => jsonResponse(PROM_OK));

    const res = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: {
        kind: "victoriametrics",
        query: { url: "http://vmsingle:8428" },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).rules).toBeNull();
  });

  /* One connection per product: what you point at is already an aggregate, so
     a second Prometheus is a mistake to refuse rather than a name to invent. */
  // What you point at is already an aggregate, so a second one is a mistake.
  it("refuses a second metrics source, of its own kind or any other", async () => {
    stubFetch(() => jsonResponse(PROM_OK));
    const first = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: { kind: "prometheus", query: { url: "http://prom-a:9090" } },
    });
    const sameKind = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: { kind: "prometheus", query: { url: "http://prom-b:9090" } },
    });
    const otherKind = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: { kind: "thanos", query: { url: "http://thanos:10902" } },
    });

    expect(first.statusCode).toBe(201);
    expect(sameKind.statusCode).toBe(409);
    expect(otherKind.statusCode).toBe(409);
    expect(JSON.parse(otherKind.body).error).toMatch(/already connected/);
  });

  it("refuses to save when the probe fails - envelope error maps to 400, unreachable to 502", async () => {
    const payload = {
      kind: "prometheus",
      query: { url: "http://prom.internal:9090" },
    };
    stubFetch(() =>
      jsonResponse(
        { status: "error", errorType: "bad_data", error: "unknown function" },
        { status: 400 },
      ),
    );
    const badQuery = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload,
    });
    expect(badQuery.statusCode).toBe(400);
    expect(JSON.parse(badQuery.body).code).toBe("bad_query");

    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const unreachable = await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload,
    });
    expect(unreachable.statusCode).toBe(502);
    expect(JSON.parse(unreachable.body).code).toBe("network");

    const status = await authed({
      method: "GET",
      url: "/api/integrations/metrics",
    });
    expect(JSON.parse(status.body).configured).toBe(false);
  });

  // No id in the path, as Loki has none: there is one source or none, so
  // disconnecting twice is idempotent rather than a 404.
  it("disconnects the one source, and disconnecting nothing is a no-op", async () => {
    stubFetch(() => jsonResponse(PROM_OK));
    await authed({
      method: "POST",
      url: "/api/integrations/metrics",
      payload: { kind: "thanos", query: { url: "http://thanos:10902" } },
    });

    const gone = await authed({
      method: "DELETE",
      url: "/api/integrations/metrics",
    });
    expect(gone.statusCode).toBe(204);

    const again = await authed({
      method: "DELETE",
      url: "/api/integrations/metrics",
    });
    expect(again.statusCode).toBe(204);
    const after = await authed({
      method: "GET",
      url: "/api/integrations/metrics",
    });
    expect(JSON.parse(after.body).configured).toBe(false);
  });
});

describe("Alertmanager integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
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

  function authed(opts: { method: "GET" | "POST" | "DELETE"; url: string }) {
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
      url: "/api/integrations/alerting/alertmanager",
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await authed({
      method: "GET",
      url: "/api/integrations/alerting/alertmanager",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.ingestUrl).toMatch(/\/alerts\/ingest$/);
    expect(body.lastReceivedAt).toBeNull();

    const reveal = await authed({
      method: "POST",
      url: "/api/integrations/alerting/alertmanager/credential/reveal",
    });
    expect(reveal.statusCode).toBe(404);
  });

  // A typo would otherwise mint a credential nothing can present, leaving a
  // card that never turns green.
  it("refuses a sender it does not know, on every route in the family", async () => {
    const routes = [
      { method: "GET" as const, url: "/api/integrations/alerting/nessus" },
      {
        method: "POST" as const,
        url: "/api/integrations/alerting/nessus/credential",
      },
      { method: "DELETE" as const, url: "/api/integrations/alerting/nessus" },
    ];
    for (const route of routes) {
      const res = await authed(route);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({
        error: "Unknown alert source: nessus",
      });
    }
  });

  it("mints an nwi_ credential, stores only its hash, and never hands it back", async () => {
    const res = await authed({
      method: "POST",
      url: "/api/integrations/alerting/alertmanager/credential",
    });
    expect(res.statusCode).toBe(201);
    const { token } = JSON.parse(res.body) as { token: string };
    expect(token).toMatch(/^nwi_[A-Za-z0-9_-]{43}$/);

    const row = (await getDb()
      .selectFrom("integrations")
      .select("token_hash")
      .where("kind", "=", "alertmanager")
      .executeTakeFirst())!;
    expect(row.token_hash).toBe(sha256hex(token));
    expect(row.token_hash).not.toContain("nwi_");

    // Shown once at mint and never again: nothing stores a readable copy, so
    // no route can answer with one.
    const reveal = await authed({
      method: "POST",
      url: "/api/integrations/alerting/alertmanager/credential/reveal",
    });
    expect(reveal.statusCode).toBe(404);

    const status = await authed({
      method: "GET",
      url: "/api/integrations/alerting/alertmanager",
    });
    expect(JSON.parse(status.body)).toMatchObject({ configured: true });
  });

  it("rotation replaces the hash and resets the delivery stamp", async () => {
    const first = await authed({
      method: "POST",
      url: "/api/integrations/alerting/alertmanager/credential",
    });
    const { token: oldToken } = JSON.parse(first.body) as { token: string };
    await setAlertSourceReceived("alertmanager", "2026-07-18T03:12:00.000Z");

    const before = await authed({
      method: "GET",
      url: "/api/integrations/alerting/alertmanager",
    });
    expect(
      (JSON.parse(before.body) as { lastReceivedAt: string | null })
        .lastReceivedAt,
    ).toBe("2026-07-18T03:12:00.000Z");

    const second = await authed({
      method: "POST",
      url: "/api/integrations/alerting/alertmanager/credential",
    });
    const { token: newToken } = JSON.parse(second.body) as { token: string };
    expect(newToken).not.toBe(oldToken);

    const row = (await getDb()
      .selectFrom("integrations")
      .select(["token_hash", "last_used_at"])
      .where("kind", "=", "alertmanager")
      .executeTakeFirst())!;
    expect(row.token_hash).toBe(sha256hex(newToken));
    expect(row.token_hash).not.toBe(sha256hex(oldToken));
    expect(row.last_used_at).toBeNull();
  });
});

describe("Loki integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  const LOKI_LABELS = { status: "success", data: ["app", "namespace"] };

  beforeAll(async () => {
    cleanupDb = await useTempDb();
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

  afterEach(async () => {
    vi.unstubAllGlobals();
    await deleteLokiIntegration();
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

    const row = (await getDb()
      .selectFrom("integrations")
      .select("config")
      .where("kind", "=", "loki")
      .executeTakeFirst())!;
    expect(await storedSecret("loki", "authorization")).toBe(
      "Bearer secret-123",
    );
    expect(await rawSecrets("loki")).not.toContain("secret-123");
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
});

describe("Sentry integration routes", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
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

  afterEach(async () => {
    vi.unstubAllGlobals();
    await deleteSentryIntegration();
  });

  const URL_ = "/api/integrations/sentry";

  const CONNECT = {
    url: "https://sentry.internal/",
    orgSlug: "acme",
    token: "sntrys_secret",
  };

  function authed(
    method: "GET" | "POST" | "DELETE",
    payload?: Record<string, unknown>,
  ) {
    return server.inject({
      method,
      url: URL_,
      ...(payload !== undefined && { payload }),
      headers: { cookie: `nw_auth=${SESSION}` },
    });
  }

  const connect = (payload: Record<string, unknown> = CONNECT) =>
    authed("POST", payload);
  const status = () => authed("GET");
  // Both probes answer an empty page, which is a token holding both scopes.
  const probeOk = () => stubFetch(() => jsonResponse([]));

  it("reports not configured before onboarding and requires a session", async () => {
    const unauthed = await server.inject({ method: "GET", url: URL_ });
    expect(unauthed.statusCode).toBe(401);

    const res = await status();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: false,
      url: null,
      orgSlug: null,
      validatedAt: null,
    });
  });

  it("probes both scopes before saving, and stores the token encrypted", async () => {
    const paths: string[] = [];
    const mock = stubFetch((url, init) => {
      paths.push(new URL(url).pathname);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sntrys_secret");
      return jsonResponse([]);
    });

    const res = await connect();
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      url: "https://sentry.internal/",
      orgSlug: "acme",
      validatedAt: expect.any(String),
    });
    // Issues answer to event:read and releases to project:read, so a token
    // holding one and not the other has to fail here rather than at 3am.
    expect(paths).toEqual([
      "/api/0/organizations/acme/issues/",
      "/api/0/organizations/acme/releases/",
    ]);
    expect(String(mock.mock.calls[0]?.[0])).not.toContain("sntrys_secret");

    expect(await storedSecret("sentry", "token")).toBe("sntrys_secret");
    expect(await rawSecrets("sentry")).not.toContain("sntrys_secret");
    const row = (await getDb()
      .selectFrom("integrations")
      .select("config")
      .where("kind", "=", "sentry")
      .executeTakeFirst())!;
    expect(JSON.parse(row.config)).toEqual({
      baseUrl: "https://sentry.internal/",
      orgSlug: "acme",
    });
  });

  it("names the missing scope when only the releases probe is refused", async () => {
    stubFetch((url) =>
      new URL(url).pathname.endsWith("/releases/")
        ? new Response("forbidden", { status: 403 })
        : jsonResponse([]),
    );

    const res = await connect();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("forbidden");
    expect(JSON.parse(res.body).error).toContain("project:read");
    expect(JSON.parse((await status()).body).configured).toBe(false);
  });

  it("separates a rejected token, a wrong org slug and an unreachable host", async () => {
    stubFetch(() => new Response("no", { status: 401 }));
    const rejected = await connect();
    expect(rejected.statusCode).toBe(401);
    expect(JSON.parse(rejected.body).code).toBe("unauthorized");

    stubFetch(() => new Response("no", { status: 404 }));
    const wrongOrg = await connect();
    expect(wrongOrg.statusCode).toBe(404);
    expect(JSON.parse(wrongOrg.body).error).toContain("organization slug");

    stubFetch(() => {
      throw Object.assign(new Error("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    });
    const unreachable = await connect();
    expect(unreachable.statusCode).toBe(502);
    expect(JSON.parse(unreachable.body).code).toBe("network");
  });

  it("rejects a body missing the organization slug without calling Sentry", async () => {
    const mock = probeOk();
    const res = await connect({ url: "https://sentry.internal", token: "t" });
    expect(res.statusCode).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it("disconnects: deletes the stored row and reports not configured", async () => {
    probeOk();
    await connect();

    const res = await authed("DELETE");
    expect(res.statusCode).toBe(204);
    expect(JSON.parse((await status()).body).configured).toBe(false);
  });
});
