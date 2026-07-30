import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilityManifest,
  RunnerCommandMessage,
} from "@nightwarden/shared";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  getFleetView,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import {
  resolveCommand,
  sendCommand,
  sendFleetCommand,
} from "../ws/command-transport.js";
import { isSharedTarget } from "../ws/router.js";

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
  substrate: "docker" | "kubernetes" = "docker",
): CapabilityManifest {
  return {
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: substrate === "docker",
      kubernetes: substrate === "kubernetes",
      services: containers.map((name) => ({
        identity: svc(name),
        status: "running",
      })),
      postgres: { available: false },
      redis: { available: false },
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
    opts: {
      serverName?: string;
      substrate?: "docker" | "kubernetes";
      // Accepts the command and never answers, so the caller times out.
      silent?: boolean;
    } = {},
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
    conns.push(
      registerRunner(
        runnerId,
        opts.silent === true ? () => {} : makeSend(commands),
        () => {},
        opts.serverName ?? null,
      ),
    );
    setRunnerManifest(
      runnerId,
      makeManifest(hostname, containers, opts.substrate),
    );
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

  describe("service routes", () => {
    it("routes a command to the one runner that advertises the target", async () => {
      const a = connect("web-01", ["nginx"]);
      const b = connect("db-02", ["postgres"]);

      await sendCommand("GetDockerLogs", { target: key("postgres") });

      expect(b.commands).toHaveLength(1);
      expect(a.commands).toHaveLength(0);
    });

    it("strips both addressing parameters, leaving the runner the structured identity", async () => {
      const a = connect("web-01", ["nginx"], { serverName: "prod-1" });

      await sendCommand("GetDockerLogs", {
        target: key("nginx"),
        runner: "prod-1",
        tailLines: 50,
      });

      expect(a.commands[0]?.commandInput).toEqual({
        service: svc("nginx"),
        tailLines: 50,
      });
    });

    it("rejects an unknown target even when only one runner is connected", () => {
      connect("web-01", ["nginx"]);

      expect(() =>
        sendCommand("GetDockerLogs", { target: key("ghost") }),
      ).toThrow(/No runner has target/);
    });

    it("rejects a service-routed command that carries no target", () => {
      connect("web-01", ["nginx"]);

      expect(() => sendCommand("GetDockerLogs", {})).toThrow(
        /requires a 'target' key/,
      );
    });

    describe("a target two runners advertise", () => {
      it("names both and asks for a runner, rather than silently picking one", () => {
        connect("web-01", ["nginx"], { serverName: "prod-1" });
        connect("web-02", ["nginx"], { serverName: "prod-2" });

        expect(() =>
          sendCommand("GetDockerLogs", { target: key("nginx") }),
        ).toThrow(/advertised by more than one runner \(prod-1, prod-2\)/);
      });

      it("routes to the runner the model named", async () => {
        const a = connect("web-01", ["nginx"], { serverName: "prod-1" });
        const b = connect("web-02", ["nginx"], { serverName: "prod-2" });

        await sendCommand("GetDockerLogs", {
          target: key("nginx"),
          runner: "prod-2",
        });

        expect(b.commands).toHaveLength(1);
        expect(a.commands).toHaveLength(0);
      });

      it("fails loud when the named runner does not advertise the target", () => {
        connect("web-01", ["nginx"], { serverName: "prod-1" });
        connect("web-02", ["nginx"], { serverName: "prod-2" });

        expect(() =>
          sendCommand("GetDockerLogs", {
            target: key("nginx"),
            runner: "ghost-99",
          }),
        ).toThrow(/No runner named 'ghost-99'/);
      });
    });

    it("ignores a stale runner name when the target has exactly one owner", async () => {
      // One possible destination is not worth failing a call over.
      const a = connect("web-01", ["nginx"], { serverName: "prod-1" });

      await sendCommand("GetDockerLogs", {
        target: key("nginx"),
        runner: "long-gone",
      });

      expect(a.commands).toHaveLength(1);
    });
  });

  describe("runner routes", () => {
    it("fans out to every runner of the substrate when no runner is named", async () => {
      const a = connect("web-01", ["nginx"]);
      const b = connect("db-02", ["postgres"]);

      const { envelope } = await sendFleetCommand("GetHostDisk", {}, "docker");

      expect(a.commands).toHaveLength(1);
      expect(b.commands).toHaveLength(1);
      expect(envelope.byRunner.map((e) => e.runner).sort()).toEqual([
        "db-02",
        "web-01",
      ]);
    });

    it("envelopes a single runner's result too, so there is one shape to read", async () => {
      connect("web-01", ["nginx"], { serverName: "prod-1" });

      const { envelope } = await sendFleetCommand(
        "GetHostDisk",
        { runner: "prod-1" },
        "docker",
      );

      expect(envelope.byRunner).toEqual([
        { runner: "prod-1", result: { ok: true } },
      ]);
    });

    it("reaches only runners advertising the substrate", async () => {
      const dockerHost = connect("web-01", ["nginx"]);
      const cluster = connect("k8s-01", ["api"], { substrate: "kubernetes" });

      await sendFleetCommand("GetHostDisk", {}, "docker");

      expect(dockerHost.commands).toHaveLength(1);
      expect(cluster.commands).toHaveLength(0);
    });

    it("says which substrate is missing, rather than claiming no runner is connected", async () => {
      connect("k8s-01", ["api"], { substrate: "kubernetes" });

      await expect(
        sendFleetCommand("GetHostDisk", {}, "docker"),
      ).rejects.toThrow(/No connected runner runs docker/);
    });

    it("caps a fan-out at eight runners", async () => {
      for (let i = 0; i < 10; i++) connect(`host-${i}`, ["nginx"]);

      const { envelope } = await sendFleetCommand("GetHostDisk", {}, "docker");

      expect(envelope.byRunner).toHaveLength(8);
    });

    it("strips the runner parameter before dispatch", async () => {
      const a = connect("web-01", ["nginx"], { serverName: "prod-1" });

      await sendFleetCommand(
        "GetHostDmesg",
        { runner: "prod-1", tailLines: 20 },
        "docker",
      );

      expect(a.commands[0]?.commandInput).toEqual({ tailLines: 20 });
    });

    it("fails loud on an unknown runner name", async () => {
      connect("web-01", ["nginx"]);

      await expect(
        sendFleetCommand("GetHostDisk", { runner: "ghost-99" }, "docker"),
      ).rejects.toThrow(/No docker runner named 'ghost-99'/);
    });

    it("the operator-assigned name is the address, beating the OS hostname", async () => {
      // Two boxes could both self-report "ubuntu"; only assigned names are unique.
      const a = connect("ubuntu", ["nginx"], { serverName: "prod-1" });

      await sendFleetCommand("GetHostDisk", { runner: "prod-1" }, "docker");
      expect(a.commands).toHaveLength(1);

      await expect(
        sendFleetCommand("GetHostDisk", { runner: "ubuntu" }, "docker"),
      ).rejects.toThrow(/No docker runner named 'ubuntu'/);
    });

    describe("a runner failing inside a fan-out", () => {
      it("becomes that entry's result, and the others still return", async () => {
        const ok = connect("web-01", ["nginx"], { serverName: "prod-1" });
        connect("web-02", ["nginx"], { serverName: "prod-2", silent: true });

        const { envelope, anySucceeded } = await sendFleetCommand(
          "GetHostDisk",
          {},
          "docker",
          20,
        );

        expect(ok.commands).toHaveLength(1);
        expect(anySucceeded).toBe(true);
        const failed = envelope.byRunner.find((e) => e.runner === "prod-2");
        expect(failed?.result).toMatch(/timed out/);
      });

      it("reports the call as failed only when no runner succeeded", async () => {
        connect("web-01", ["nginx"], { serverName: "prod-1", silent: true });
        connect("web-02", ["nginx"], { serverName: "prod-2", silent: true });

        const { anySucceeded, envelope } = await sendFleetCommand(
          "GetHostDisk",
          {},
          "docker",
          20,
        );

        expect(anySucceeded).toBe(false);
        expect(envelope.byRunner).toHaveLength(2);
      });
    });
  });

  describe("isSharedTarget", () => {
    it("is true only for a key more than one runner advertises", () => {
      connect("web-01", ["nginx", "api"]);
      connect("web-02", ["nginx"]);

      expect(isSharedTarget(key("nginx"))).toBe(true);
      expect(isSharedTarget(key("api"))).toBe(false);
      expect(isSharedTarget(key("ghost"))).toBe(false);
    });

    it("is false when no runner is connected at all", () => {
      expect(isSharedTarget(key("nginx"))).toBe(false);
    });
  });
});
