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
  getFleetView,
} from "../ws/router.js";
import type { RunnerConnection } from "../ws/router.js";
import { resolveCommand, sendCommand } from "../ws/command-transport.js";
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
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: containers.map((name) => ({
        identity: svc(name),
        status: "running",
      })),
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
  const conns: RunnerConnection[] = [];

  function connect(
    hostname: string,
    containers: string[],
  ): {
    runnerId: string;
    commands: Array<{
      commandName: string;
      commandInput: Record<string, unknown>;
    }>;
  } {
    const runnerId = randomUUID();
    const commands: Array<{
      commandName: string;
      commandInput: Record<string, unknown>;
    }> = [];
    conns.push(registerRunner(runnerId, makeSend(commands), () => {}));
    setRunnerManifest(runnerId, makeManifest(hostname, containers));
    return { runnerId, commands };
  }

  afterEach(() => {
    for (const conn of conns.splice(0)) unregisterRunner(conn);
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

    await sendCommand(
      "get_service_logs",
      { service: svc("postgres") },
      "service",
    );

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
  });

  it("rejects a command targeting an unknown service identity even when only one runner is connected", () => {
    connect("web-01", ["nginx"]);

    expect(() =>
      sendCommand("get_service_logs", { service: svc("ghost") }, "service"),
    ).toThrow(/No runner has service/);
  });

  it("rejects a command targeting a service identity advertised by more than one runner, rather than silently picking one", () => {
    connect("web-01", ["nginx"]);
    connect("web-02", ["nginx"]);

    expect(() =>
      sendCommand("get_service_logs", { service: svc("nginx") }, "service"),
    ).toThrow(/Ambiguous service/);
  });

  it("rejects a service-routed command that carries no service identity", () => {
    connect("web-01", ["nginx"]);

    expect(() => sendCommand("get_service_logs", {}, "service")).toThrow(
      /requires a 'service' identity/,
    );
  });

  it("routes a hostless host command to the single connected runner with no warning", async () => {
    const warn = vi.spyOn(logger, "warn");
    const a = connect("web-01", ["nginx"]);

    await sendCommand("get_host_memory", {}, "host");

    expect(a.commands).toHaveLength(1);
    expect(warn.mock.calls.flat()).not.toContainEqual(
      expect.stringMatching(/deprecat/i),
    );
  });

  it("routes a host command by hostname across multiple runners with no warning", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);
    const warn = vi.spyOn(logger, "warn");

    await sendCommand("get_host_memory", { hostname: "db-02" }, "host");

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
    expect(warn.mock.calls.flat()).not.toContainEqual(
      expect.stringMatching(/deprecat/i),
    );
  });

  it("an explicit hostname beats the runnerIdHint", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);

    await sendCommand(
      "get_host_memory",
      { hostname: "db-02" },
      "host",
      15_000,
      a.runnerId,
    );

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
  });

  it("an unknown hostname fails loud even when a runnerIdHint could route", () => {
    const a = connect("web-01", ["nginx"]);
    connect("db-02", ["postgres"]);

    expect(() =>
      sendCommand(
        "get_host_memory",
        { hostname: "ghost-99" },
        "host",
        15_000,
        a.runnerId,
      ),
    ).toThrow(/No runner has hostname 'ghost-99'/);
  });

  it("without a hostname, a host command routes to the alerting session's runner via the hint", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);

    await sendCommand("get_host_memory", {}, "host", 15_000, b.runnerId);

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
  });

  it("a hostless, hintless host command on a multi-runner fleet fails loud listing hostnames", () => {
    connect("web-01", ["nginx"]);
    connect("db-02", ["postgres"]);

    expect(() => sendCommand("get_host_memory", {}, "host")).toThrow(
      /Specify a hostname parameter/,
    );
  });
});
