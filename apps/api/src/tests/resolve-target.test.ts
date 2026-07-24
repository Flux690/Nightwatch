import { describe, expect, it } from "vitest";
import type { FleetRunner, ServiceIdentity } from "@nightwatch/shared";
import { resolveAgainstFleet } from "../alerts/resolve-target.js";

function runner(
  serverName: string,
  identities: ServiceIdentity[],
): FleetRunner {
  return {
    runnerId: `r-${serverName}`,
    serverName,
    hostname: `${serverName}-host`,
    online: true,
    lastSeen: Date.now(),
    services: identities.map((identity) => ({
      identity,
      status: "running" as const,
    })),
    remediationEnabled: true,
  };
}

const svc = (server: string, service: string): ServiceIdentity => ({
  provider: "docker",
  project: "clipper",
  service,
  server,
});

// Two servers, both running clipper/cache; only prod-1 runs clipper/api.
const FLEET: FleetRunner[] = [
  runner("prod-1", [svc("prod-1", "cache"), svc("prod-1", "api")]),
  runner("prod-2", [svc("prod-2", "cache")]),
];

describe("resolveAgainstFleet", () => {
  it("resolves an exact scoped match", () => {
    const res = resolveAgainstFleet(
      {
        provider: "docker",
        project: "clipper",
        service: "cache",
        server: "prod-1",
      },
      FLEET,
    );
    expect(res.kind).toBe("resolved");
    expect(res.kind === "resolved" && res.key).toBe(
      "docker/prod-1/clipper/cache",
    );
  });

  it("resolves an unscoped candidate when exactly one server matches", () => {
    const res = resolveAgainstFleet(
      { provider: "docker", project: "clipper", service: "api" },
      FLEET,
    );
    expect(res.kind).toBe("resolved");
    expect(res.kind === "resolved" && res.key).toBe(
      "docker/prod-1/clipper/api",
    );
  });

  it("is ambiguous when an unscoped candidate matches several servers", () => {
    const res = resolveAgainstFleet(
      { provider: "docker", project: "clipper", service: "cache" },
      FLEET,
    );
    expect(res.kind).toBe("ambiguous");
    expect(res.kind === "ambiguous" && res.servers.sort()).toEqual([
      "prod-1",
      "prod-2",
    ]);
  });

  it("is unresolved when nothing matches", () => {
    const res = resolveAgainstFleet(
      { provider: "docker", project: "clipper", service: "ghost" },
      FLEET,
    );
    expect(res).toEqual({ kind: "unresolved", key: "docker/clipper/ghost" });
  });

  it("is unresolved for a null candidate (labels named no service)", () => {
    expect(resolveAgainstFleet(null, FLEET)).toEqual({
      kind: "unresolved",
      key: null,
    });
  });
});
