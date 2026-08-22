import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import {
  dockerServiceKey,
  type Platform,
  type RunnerCommandMessage,
} from "@nightwarden/shared";
import { generateRunnerToken } from "../db/runner.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { mountApi } from "./api-server.js";
import {
  dockerService,
  kubernetesManifest,
  kubernetesWorkload,
  manifest,
} from "./manifest-helper.js";
import { mintTestSession } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

/* One wired world: a database, a login, a server on a port, and runners that
   answer. It decides nothing - what a runner replies is the test's own, passed
   in as `answer` - so a test still reads as what it is asserting. */

type Registrar = (instance: FastifyInstance) => Promise<void>;

export interface Command {
  commandName: string;
  commandInput: Record<string, unknown>;
}

export interface RunnerSpec {
  platform?: Platform;
  // Also the runner's address in a `runner` argument and in the fleet summary.
  name?: string;
  /* Docker target names, or "namespace/workload" for Kubernetes. Advertised
     exactly as the real manifest would, so a target key resolves. */
  services?: string[];
  // What the fake socket sends back. Omitted answers every command with [].
  answer?: (command: Command) => unknown;
}

export interface HarnessRunner {
  id: string;
  name: string;
  connection: RunnerConnection;
  // Every command this runner was sent, in order, so no test keeps its own array.
  commands: Command[];
}

export interface Harness {
  server: FastifyInstance;
  port: number;
  // Ready to spread into a request: { headers: harness.headers }.
  headers: { cookie: string };
  session: string;
  runners: HarnessRunner[];
  runner: HarnessRunner;
  url(path: string): string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  routes?: Registrar[];
  runners?: RunnerSpec[];
  // Off for a test that only needs inject(), which needs no open port.
  listen?: boolean;
}

function manifestFor(
  spec: Required<Pick<RunnerSpec, "platform">> & RunnerSpec,
) {
  const services = spec.services ?? [];
  if (spec.platform === "kubernetes") {
    return kubernetesManifest(
      spec.name ?? "test-cluster",
      services.map((service) => {
        const [namespace, workload] = service.split("/");
        return kubernetesWorkload(namespace ?? "default", workload ?? service);
      }),
    );
  }
  /* "project/service" where a Compose pair matters, a bare name where it does
     not - which is the anonymous-container convention dockerService builds. */
  return manifest(
    spec.name ?? "test-host",
    services.map((service) => {
      if (!service.includes("/")) return dockerService(service);
      const [project, name] = service.split("/") as [string, string];
      const identity = { project, service: name };
      return {
        identity,
        target: dockerServiceKey(identity),
        status: "running",
      };
    }),
  );
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const cleanupDb = useTempDb();
  const session = await mintTestSession();

  const runners: HarnessRunner[] = (options.runners ?? []).map(
    (spec, index) => {
      const platform = spec.platform ?? "docker";
      const name = spec.name ?? `test-runner-${index + 1}`;
      const id = generateRunnerToken(platform, name, name).id;
      const commands: Command[] = [];
      const connection = registerRunner({
        runnerId: id,
        platform,
        serverName: name,
        send: (raw: string) => {
          const { payload } = JSON.parse(raw) as RunnerCommandMessage;
          const command = {
            commandName: payload.commandName,
            commandInput: payload.commandInput,
          };
          commands.push(command);
          resolveCommand({
            correlationId: payload.correlationId,
            success: true,
            result: spec.answer ? spec.answer(command) : [],
          });
        },
        close: () => {},
      });
      setRunnerManifest(id, manifestFor({ ...spec, platform, name }));
      return { id, name, connection, commands };
    },
  );

  // trustProxy as index.ts sets it, so x-forwarded-proto behaves as in production.
  const server = Fastify({
    logger: false,
    trustProxy: true,
    forceCloseConnections: true,
  });
  // Registered always: the ws route needs it before mounting, and a test that
  // never opens a socket pays nothing for it.
  await server.register(FastifyWebSocket);
  await mountApi(server, ...(options.routes ?? []));
  let port = 0;
  if (options.listen === false) {
    await server.ready();
  } else {
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  }

  return {
    server,
    port,
    session,
    headers: { cookie: `nw_auth=${session}` },
    runners,
    // The common case is one, and naming it saves every test an index.
    get runner() {
      const only = runners[0];
      if (only === undefined) throw new Error("this harness has no runner");
      return only;
    },
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async close() {
      for (const entry of runners) unregisterRunner(entry.connection);
      await server.close();
      cleanupDb();
    },
  };
}
