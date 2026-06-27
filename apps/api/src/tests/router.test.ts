import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilityManifest,
  RunnerCommandMessage,
} from "@nightwatch/shared";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  resolveCommand,
  sendCommand,
  getFleetView,
} from "../ws/router.js";
import { logger } from "../logger.js";

function svc(name: string): {
  provider: "docker";
  project: string;
  service: string;
} {
  return { provider: "docker", project: name, service: name };
}

function makeManifest(
  hostname: string,
  containers: string[],
): CapabilityManifest {
  return {
    runnerId: `runner-${hostname}`,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: containers.map((name) => ({
        identity: svc(name),
        status: "running",
      })),
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: true,
    },
  };
}

function makeSend(
  log: Array<{ commandName: string; commandInput: Record<string, unknown> }>,
) {
  return (raw: string): void => {
    const msg = JSON.parse(raw) as RunnerCommandMessage;
    const { commandName, commandInput, correlationId } = msg.payload;
    log.push({ commandName, commandInput });
    resolveCommand({ correlationId, success: true, result: { ok: true } });
  };
}

describe("router", () => {
  const tokenIds: string[] = [];

  function connect(
    hostname: string,
    containers: string[],
  ): {
    tokenId: string;
    commands: Array<{
      commandName: string;
      commandInput: Record<string, unknown>;
    }>;
  } {
    const tokenId = randomUUID();
    tokenIds.push(tokenId);
    const commands: Array<{
      commandName: string;
      commandInput: Record<string, unknown>;
    }> = [];
    registerRunner(tokenId, makeSend(commands), () => {});
    setRunnerManifest(tokenId, makeManifest(hostname, containers));
    return { tokenId, commands };
  }

  afterEach(() => {
    for (const id of tokenIds.splice(0)) unregisterRunner(id);
    vi.restoreAllMocks();
  });

  it("getFleetView returns every connected runner with its advertised service identities", () => {
    connect("web-01", ["nginx", "api"]);
    connect("db-02", ["postgres"]);

    const fleet = getFleetView();
    const byHostname = new Map(fleet.map((r) => [r.hostname, r]));

    expect(byHostname.get("web-01")?.services).toEqual([
      { identity: svc("nginx"), status: "running" },
      { identity: svc("api"), status: "running" },
    ]);
    expect(byHostname.get("db-02")?.services).toEqual([
      { identity: svc("postgres"), status: "running" },
    ]);
    expect(byHostname.get("web-01")?.online).toBe(true);
  });

  it("routes a command targeting a known service identity to the runner that owns it", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);

    await sendCommand("get_service_logs", { service: svc("postgres") });

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
  });

  it("rejects a command targeting an unknown service identity even when only one runner is connected", () => {
    connect("web-01", ["nginx"]);

    expect(() =>
      sendCommand("get_service_logs", { service: svc("ghost") }),
    ).toThrow(/No runner has service/);
  });

  it("rejects a command targeting a service identity advertised by more than one runner, rather than silently picking one", () => {
    connect("web-01", ["nginx"]);
    connect("web-02", ["nginx"]);

    expect(() =>
      sendCommand("get_service_logs", { service: svc("nginx") }),
    ).toThrow(/Ambiguous service/);
  });

  it("falls back to the single connected runner for a hostless, serviceless command and logs a deprecation warning", async () => {
    const warn = vi.spyOn(logger, "warn");
    const a = connect("web-01", ["nginx"]);

    await sendCommand("get_host_memory", {});

    expect(a.commands).toHaveLength(1);
    expect(warn.mock.calls.flat()).toContainEqual(
      expect.stringMatching(/deprecat/i),
    );
  });

  it("falls back to hostname matching across multiple runners and logs a deprecation warning", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);
    const warn = vi.spyOn(logger, "warn");

    await sendCommand("get_host_memory", { hostname: "db-02" });

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/deprecat/i),
    );
  });
});
