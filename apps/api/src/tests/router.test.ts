import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Platform,
  RunnerManifest,
  RunnerCommandMessage,
} from "@nightwarden/shared";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  getFleetView,
} from "../fleet/connections.js";
import type { RunnerConnection } from "../fleet/connections.js";
import {
  resolveCommand,
  sendCommand,
  sendFleetCommand,
} from "../fleet/transport.js";
import { dockerService, kubernetesWorkload, svc } from "./manifest-helper.js";

// The flat key dockerService(server, name) advertises: <server>/<project>/<service>.
function key(server: string, name: string): string {
  return `${server}/${name}/${name}`;
}

// Deliberately unlike the server name: only the assigned name is an address, and
// a test that used the hostname would pass for the wrong reason.
function hostnameOf(server: string): string {
  return `${server}.internal`;
}

function makeManifest(
  server: string,
  containers: string[],
  platform: Platform = "docker",
): RunnerManifest {
  return platform === "docker"
    ? {
        platform,
        hostname: hostnameOf(server),
        runnerVersion: "3.0.0",
        services: containers.map((name) => dockerService(server, name)),
      }
    : {
        platform,
        hostname: hostnameOf(server),
        runnerVersion: "3.0.0",
        services: containers.map((name) =>
          kubernetesWorkload(server, "default", name),
        ),
      };
}

function makeSend(
  log: Array<{ commandName: string; commandInput: Record<string, unknown> }>,
) {
  return (raw: string): void => {
    const msg = JSON.parse(raw) as RunnerCommandMessage;
    if (msg.type !== "command") return;
    const { commandName, commandInput, correlationId } = msg.payload;
    log.push({ commandName, commandInput });
    resolveCommand({ correlationId, success: true, result: { ok: true } });
  };
}

describe("router", () => {
  const conns: RunnerConnection[] = [];

  function connect(
    server: string,
    containers: string[],
    opts: {
      platform?: Platform;
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
      registerRunner({
        runnerId: runnerId,
        platform: opts.platform ?? "docker",
        send: opts.silent === true ? () => {} : makeSend(commands),
        close: () => {},
        serverName: server,
      }),
    );
    setRunnerManifest(
      runnerId,
      makeManifest(server, containers, opts.platform),
    );
    return { runnerId, commands };
  }

  afterEach(() => {
    for (const conn of conns.splice(0)) unregisterRunner(conn);
    vi.restoreAllMocks();
  });

  it("getFleetView returns every connected server with its advertised service identities", () => {
    connect("web-01", ["nginx", "api"]);
    connect("db-02", ["postgres"]);

    const fleet = getFleetView();
    const byServer = new Map(fleet.map((r) => [r.serverName, r]));

    expect(byServer.get("web-01")?.services).toEqual([
      dockerService("web-01", "nginx"),
      dockerService("web-01", "api"),
    ]);
    expect(byServer.get("db-02")?.services).toEqual([
      dockerService("db-02", "postgres"),
    ]);
    expect(byServer.get("web-01")?.online).toBe(true);
  });

  describe("service routes", () => {
    it("routes a command to the one server that advertises the target", async () => {
      const a = connect("web-01", ["nginx"]);
      const b = connect("db-02", ["postgres"]);

      await sendCommand("GetDockerLogs", { target: key("db-02", "postgres") });

      expect(b.commands).toHaveLength(1);
      expect(a.commands).toHaveLength(0);
    });

    it("strips the target, leaving the server the structured identity", async () => {
      const a = connect("web-01", ["nginx"]);

      await sendCommand("GetDockerLogs", {
        target: key("web-01", "nginx"),
        tailLines: 50,
      });

      expect(a.commands[0]?.commandInput).toEqual({
        service: svc("nginx"),
        tailLines: 50,
      });
    });

    it("rejects an unknown target even when only one server is connected", async () => {
      connect("web-01", ["nginx"]);

      await expect(
        sendCommand("GetDockerLogs", {
          target: key("web-01", "ghost"),
        }),
      ).rejects.toThrow(/No server advertises target/);
    });

    it("rejects a service-routed command that carries no target", async () => {
      connect("web-01", ["nginx"]);

      await expect(sendCommand("GetDockerLogs", {})).rejects.toThrow(
        /requires a 'target' key/,
      );
    });

    // The whole point of the server segment: one name, one machine, nothing to
    // disambiguate and no second argument to supply.
    describe("the same service running on two servers", () => {
      it("is two distinct keys, each routing to its own server", async () => {
        const a = connect("web-01", ["nginx"]);
        const b = connect("web-02", ["nginx"]);

        await sendCommand("GetDockerLogs", { target: key("web-01", "nginx") });
        expect(a.commands).toHaveLength(1);
        expect(b.commands).toHaveLength(0);

        await sendCommand("GetDockerStats", { target: key("web-02", "nginx") });
        expect(b.commands).toHaveLength(1);
        expect(a.commands).toHaveLength(1);
      });

      it("names every known target when the server segment matches nothing", async () => {
        connect("web-01", ["nginx"]);
        connect("web-02", ["nginx"]);

        await expect(
          sendCommand("GetDockerLogs", {
            target: key("web-99", "nginx"),
          }),
        ).rejects.toThrow(/web-01\/nginx\/nginx.*web-02\/nginx\/nginx/);
      });
    });
  });

  describe("server routes", () => {
    it("reaches every server the call names", async () => {
      const a = connect("web-01", ["nginx"]);
      const b = connect("db-02", ["postgres"]);

      const { envelope } = await sendFleetCommand(
        "GetHostDisk",
        { server: ["web-01", "db-02"] },
        "docker",
      );

      expect(a.commands).toHaveLength(1);
      expect(b.commands).toHaveLength(1);
      expect(envelope.byServer.map((e) => e.server).sort()).toEqual([
        "db-02",
        "web-01",
      ]);
    });

    /* Naming one and reaching another would be a reading of the wrong machine,
       which nothing downstream could tell from the right one. */
    it("leaves a connected server the call did not name alone", async () => {
      const named = connect("web-01", ["nginx"]);
      const other = connect("db-02", ["postgres"]);

      await sendFleetCommand("GetHostDisk", { server: ["web-01"] }, "docker");

      expect(named.commands).toHaveLength(1);
      expect(other.commands).toHaveLength(0);
    });

    it("envelopes a single server's result too, so there is one shape to read", async () => {
      connect("web-01", ["nginx"]);

      const { envelope } = await sendFleetCommand(
        "GetHostDisk",
        { server: ["web-01"] },
        "docker",
      );

      expect(envelope.byServer).toEqual([
        { server: "web-01", result: { ok: true } },
      ]);
    });

    it("reaches only servers of that platform", async () => {
      const dockerHost = connect("web-01", ["nginx"]);
      const cluster = connect("k8s-01", ["api"], { platform: "kubernetes" });

      await sendFleetCommand("GetHostDisk", { server: ["web-01"] }, "docker");

      expect(dockerHost.commands).toHaveLength(1);
      expect(cluster.commands).toHaveLength(0);
    });

    it("says which platform is missing, rather than claiming no server is connected", async () => {
      connect("k8s-01", ["api"], { platform: "kubernetes" });

      await expect(
        sendFleetCommand("GetHostDisk", { server: ["web-01"] }, "docker"),
      ).rejects.toThrow(/No connected server runs docker/);
    });

    it("strips the server parameter before dispatch", async () => {
      const a = connect("web-01", ["nginx"]);

      await sendFleetCommand(
        "GetHostDmesg",
        { server: ["web-01"], tailLines: 20 },
        "docker",
      );

      expect(a.commands[0]?.commandInput).toEqual({ tailLines: 20 });
    });

    it("fails loud on an unknown server name", async () => {
      connect("web-01", ["nginx"]);

      await expect(
        sendFleetCommand("GetHostDisk", { server: ["ghost-99"] }, "docker"),
      ).rejects.toThrow(/No docker server named 'ghost-99'/);
    });

    it("the assigned name is the address; the OS hostname is not one", async () => {
      // Two boxes could both self-report "ubuntu"; only assigned names are unique.
      const a = connect("prod-1", ["nginx"]);

      await sendFleetCommand("GetHostDisk", { server: ["prod-1"] }, "docker");
      expect(a.commands).toHaveLength(1);

      await expect(
        sendFleetCommand(
          "GetHostDisk",
          { server: [hostnameOf("prod-1")] },
          "docker",
        ),
      ).rejects.toThrow(/No docker server named/);
    });

    describe("a server failing inside a fan-out", () => {
      it("becomes that entry's result, and the others still return", async () => {
        const ok = connect("prod-1", ["nginx"]);
        connect("prod-2", ["nginx"], { silent: true });

        const {
          envelope,
          succeeded,
          failed: failedCount,
        } = await sendFleetCommand(
          "GetHostDisk",
          { server: ["prod-1", "prod-2"] },
          "docker",
          20,
        );

        expect(ok.commands).toHaveLength(1);
        expect(succeeded).toBe(1);
        expect(failedCount).toBe(1);
        const failed = envelope.byServer.find((e) => e.server === "prod-2");
        expect(failed?.result).toMatch(/timed out/);
      });

      it("reports the call as failed only when no server succeeded", async () => {
        connect("prod-1", ["nginx"], { silent: true });
        connect("prod-2", ["nginx"], { silent: true });

        const { succeeded, envelope } = await sendFleetCommand(
          "GetHostDisk",
          { server: ["prod-1", "prod-2"] },
          "docker",
          20,
        );

        expect(succeeded).toBe(0);
        expect(envelope.byServer).toHaveLength(2);
      });
    });
  });
});
