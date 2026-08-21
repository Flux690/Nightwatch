import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { registerAlertRoutes } from "../alerts/ingest.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { registerTokenRoutes } from "../auth/token.js";
import { registerConfigRoutes } from "../config/routes.js";
import { registerIntegrationRoutes } from "../integrations/routes.js";
import { registerMetricsRoutes } from "../integrations/metrics/routes.js";
import { registerInstallRoutes } from "../runners/install.js";
import { registerRunnerRoutes } from "../runners/routes.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { registerSessionRoutes } from "../session/routes.js";
import { registerWsRoutes } from "../ws/server.js";
import { mountApi } from "./api-server.js";
import { useTempDb } from "./temp-db.js";

/* One walk of the whole surface, replacing a 401 case per route file. Those
   only ever covered the routes someone remembered to write one for; this covers
   the route added tomorrow, and fails when a new one forgets its guard. */

/* Public by design, and the only reason this list exists: a route not named
   here has to refuse an anonymous caller. Each is public because it is how a
   caller gets a credential, or because it verifies one of its own. */
const PUBLIC: ReadonlyArray<{ route: string; why: string }> = [
  {
    route: "POST /api/setup",
    why: "creates the first owner, before any session",
  },
  { route: "POST /api/login", why: "is how a session is obtained" },
  {
    route: "POST /api/logout",
    why: "clears a cookie and must work without one",
  },
  {
    route: "GET /api/auth/status",
    why: "answers whether an owner exists at all",
  },
  { route: "POST /api/alerts/ingest", why: "verifies its own minted token" },
  { route: "GET /api/clients/connect", why: "a runner presents its own token" },
];

const PUBLIC_ROUTES = new Set(PUBLIC.map((entry) => entry.route));

// A concrete value for every path parameter, so the request reaches the guard
// rather than dying in routing.
const STAND_INS: Record<string, string> = {
  id: "00000000-0000-4000-8000-000000000000",
  kind: "alertmanager",
  platform: "docker",
  token: "nwr_stand-in",
};

function fill(url: string): string {
  return url.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = STAND_INS[name];
    if (value === undefined) throw new Error(`no stand-in for :${name}`);
    return value;
  });
}

describe("every route refuses an anonymous caller", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  const routes: Array<{ method: string; url: string }> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        routes.push({ method, url: route.url });
      }
    });
    await mountApi(
      server,
      registerAuthRoutes,
      registerTokenRoutes,
      registerWsRoutes,
      registerConsoleEventRoutes,
      registerAlertRoutes,
      registerConfigRoutes,
      registerSessionRoutes,
      registerRunnerRoutes,
      registerInstallRoutes,
      registerIntegrationRoutes,
      registerMetricsRoutes,
    );
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("finds the whole surface, so this is not passing on an empty list", () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it("answers 401 on every route that is not deliberately public", async () => {
    const allowed: string[] = [];
    for (const { method, url } of routes) {
      const route = `${method} ${url}`;
      if (PUBLIC_ROUTES.has(route)) continue;
      const res = await server.inject({
        method: method as "GET",
        url: fill(url),
        payload: method === "GET" ? undefined : {},
      });
      if (res.statusCode !== 401) allowed.push(`${route} -> ${res.statusCode}`);
    }
    expect(allowed).toEqual([]);
  });

  /* The list cannot rot quietly in the other direction either: a route that was
     public and has since been retired would otherwise sit here forever. */
  it("names only routes that still exist", () => {
    const live = new Set(routes.map(({ method, url }) => `${method} ${url}`));
    expect(
      PUBLIC.map((entry) => entry.route).filter((r) => !live.has(r)),
    ).toEqual([]);
  });
});
