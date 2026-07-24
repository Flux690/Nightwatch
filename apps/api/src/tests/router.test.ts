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
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand, sendCommand } from "../ws/command-transport.js";
import { logger } from "../logger.js";

function svc(name: string): {
  provider: "docker";
  project: string;
  service: string;
} {
  return { provider: "docker", project: name, service: name };
}

// The flat target key svc(name) advertises: docker/<project>/<service>.
function key(name: string): string {
  return `docker/${name}/${name}`;
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

    await sendCommand("GetDockerLogs", { target: key("postgres") }, "service");

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
  });

  it("rejects a command targeting an unknown service identity even when only one runner is connected", () => {
    connect("web-01", ["nginx"]);

    expect(() =>
      sendCommand("GetDockerLogs", { target: key("ghost") }, "service"),
    ).toThrow(/No runner has target/);
  });

  it("rejects a command targeting a service identity advertised by more than one runner, rather than silently picking one", () => {
    connect("web-01", ["nginx"]);
    connect("web-02", ["nginx"]);

    expect(() =>
      sendCommand("GetDockerLogs", { target: key("nginx") }, "service"),
    ).toThrow(/Ambiguous target/);
  });

  it("rejects a service-routed command that carries no service identity", () => {
    connect("web-01", ["nginx"]);

    expect(() => sendCommand("GetDockerLogs", {}, "service")).toThrow(
      /requires a 'target' key/,
    );
  });

  it("routes a host command by server name across multiple runners with no warning", async () => {
    const a = connect("web-01", ["nginx"]);
    const b = connect("db-02", ["postgres"]);
    const warn = vi.spyOn(logger, "warn");

    await sendCommand("GetHostMemory", { server: "db-02" }, "host");

    expect(b.commands).toHaveLength(1);
    expect(a.commands).toHaveLength(0);
    expect(warn.mock.calls.flat()).not.toContainEqual(
      expect.stringMatching(/deprecat/i),
    );
  });

  it("the operator-assigned server name is the address, beating the OS hostname", async () => {
    // Two boxes could both self-report "ubuntu" - only assigned names are
    // guaranteed unique, which is why routing matches serverName first.
    const runnerId = randomUUID();
    const commands: Array<{
      commandName: string;
      commandInput: Record<string, unknown>;
    }> = [];
    conns.push(
      registerRunner(runnerId, makeSend(commands), () => {}, "prod-1"),
    );
    setRunnerManifest(runnerId, makeManifest("ubuntu", ["nginx"]));

    await sendCommand("GetHostMemory", { server: "prod-1" }, "host");
    expect(commands).toHaveLength(1);

    expect(() =>
      sendCommand("GetHostMemory", { server: "ubuntu" }, "host"),
    ).toThrow(/No server named 'ubuntu'/);
  });

  it("an unknown server name fails loud listing the available names", () => {
    connect("web-01", ["nginx"]);
    connect("db-02", ["postgres"]);

    expect(() =>
      sendCommand("GetHostMemory", { server: "ghost-99" }, "host"),
    ).toThrow(/No server named 'ghost-99'/);
  });

  it("a host command without a server parameter fails loud even on a single-runner fleet", () => {
    connect("web-01", ["nginx"]);

    expect(() => sendCommand("GetHostMemory", {}, "host")).toThrow(
      /requires a 'server' parameter/,
    );
  });
});
