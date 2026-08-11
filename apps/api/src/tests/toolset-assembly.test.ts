import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwarden/shared";
import type { ToolSchema } from "../llm/types.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createScriptRunner,
  type ContractFakeProvider,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { connectConsoleEvents } from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { effectiveToolset, getToolSchemas } from "../agent/tools/toolset.js";
import { connectedPlatforms } from "../agent/policy.js";
import { mountApi } from "./api-server.js";
import {
  kubernetesManifest,
  kubernetesWorkload,
  manifest,
} from "./manifest-helper.js";

const K8S_SERVICE = {
  namespace: "production",
  workload: "api-server",
};

describe("toolset assembly by fleet capabilities", () => {
  describe("provider library injection (unit)", () => {
    // Platform comes from the runner's row, so it is known the instant a socket
    // authenticates. There is no handshake window in which the fleet's platforms
    // are unknown, which is what the old probe-and-report manifest created.
    it("knows a runner's platform from the moment it connects, before any manifest", () => {
      expect(connectedPlatforms()).toEqual(new Set([]));

      const conn = registerRunner({
        runnerId: "caps-unit-docker",
        platform: "docker",
        send: () => {},
        close: () => {},
      });
      expect(connectedPlatforms()).toEqual(new Set(["docker" as const]));

      setRunnerManifest("caps-unit-docker", manifest("caps-unit-host", []));
      expect(connectedPlatforms()).toEqual(new Set(["docker" as const]));

      unregisterRunner(conn);
      expect(connectedPlatforms()).toEqual(new Set([]));
    });

    it("offers both provider libraries when capabilities are unknown", () => {
      const names = getToolSchemas().map((s) => s.name);
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("GetK8sLogs");
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("RestartK8sWorkload");
    });

    it("a Docker-only fleet gets Docker tools and no Kubernetes tools", () => {
      const names = getToolSchemas(new Set(["docker" as const])).map(
        (s) => s.name,
      );
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("ListDockerServices");
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("DockerBash");
      expect(names).not.toContain("GetK8sLogs");
      expect(names).not.toContain("GetK8sRolloutStatus");
      expect(names).not.toContain("GetK8sNodeStatus");
      expect(names).not.toContain("RestartK8sWorkload");
    });

    it("a Kubernetes-only fleet gets Kubernetes tools and no Docker tools", () => {
      const names = getToolSchemas(new Set(["kubernetes" as const])).map(
        (s) => s.name,
      );
      expect(names).toContain("GetK8sLogs");
      expect(names).toContain("ListK8sWorkloads");
      expect(names).toContain("GetK8sRolloutStatus");
      expect(names).toContain("GetK8sNodeStatus");
      expect(names).toContain("RestartK8sWorkload");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("RestartDockerService");
    });

    it("host tools live in the Docker library: absent on a Kubernetes-only fleet", () => {
      const hostTools = [
        "GetHostMemory",
        "GetHostCPU",
        "GetHostDisk",
        "GetHostNetwork",
        "GetHostDmesg",
        "ReadHostFile",
      ];
      const dockerNames = getToolSchemas(new Set(["docker" as const])).map(
        (s) => s.name,
      );
      const k8sNames = getToolSchemas(new Set(["kubernetes" as const])).map(
        (s) => s.name,
      );
      for (const name of hostTools) {
        expect(dockerNames).toContain(name);
        expect(k8sNames).not.toContain(name);
      }
    });

    it("a mixed fleet gets both libraries", () => {
      const names = getToolSchemas(
        new Set(["docker" as const, "kubernetes" as const]),
      ).map((s) => s.name);
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("GetK8sLogs");
    });

    it("the GitHub gate controls both the repo tools and GetRecentChanges", () => {
      const connected = getToolSchemas(undefined, { github: true }).map(
        (s) => s.name,
      );
      expect(connected).toContain("GetRecentChanges");
      expect(connected).toContain("OpenPullRequest");
      const disconnected = getToolSchemas(undefined, {
        github: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("GetRecentChanges");
      expect(disconnected).not.toContain("OpenPullRequest");
      expect(disconnected).not.toContain("Read");
    });

    it("GetRecentChanges is offered with no runner platform at all", () => {
      const names = getToolSchemas(new Set([]), {
        github: true,
      }).map((s) => s.name);
      expect(names).toContain("GetRecentChanges");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("GetK8sLogs");
    });

    it("the Prometheus gate controls the metrics tools, independent of platform", () => {
      const connected = getToolSchemas(new Set([]), {
        github: false,
        prometheus: true,
      }).map((s) => s.name);
      expect(connected).toContain("QueryMetrics");
      expect(connected).toContain("QueryMetricsRange");
      const disconnected = getToolSchemas(undefined, {
        prometheus: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("QueryMetrics");
      expect(disconnected).not.toContain("QueryMetricsRange");
    });

    it("the Loki gate controls the log tools, independent of platform", () => {
      const connected = getToolSchemas(new Set([]), {
        github: false,
        prometheus: false,
        loki: true,
      }).map((s) => s.name);
      expect(connected).toContain("QueryLogs");
      expect(connected).toContain("QueryLogMetrics");
      expect(connected).toContain("DiscoverLogLabels");
      const disconnected = getToolSchemas(undefined, { loki: false }).map(
        (s) => s.name,
      );
      expect(disconnected).not.toContain("QueryLogs");
      expect(disconnected).not.toContain("QueryLogMetrics");
      expect(disconnected).not.toContain("DiscoverLogLabels");
    });

    // The record belongs to the investigation, and nothing offered to a chat
    // can start one: what a session is was settled before the run began.
    it("offers the record's tool to an investigation and to nothing else", () => {
      const plain = effectiveToolset(new Set([]), {}, false).tools.map(
        (t) => t.schema.name,
      );
      expect(plain).not.toContain("RecordHypothesis");

      const investigating = effectiveToolset(new Set([]), {}, true).tools.map(
        (t) => t.schema.name,
      );
      expect(investigating).toContain("RecordHypothesis");
      // The composition turn's tool is the loop's to attach, never the
      // toolset's: offered here it would let a run write itself up mid-work.
      expect(investigating).not.toContain("SubmitInvestigationReport");
    });
  });

  describe("agentic loop seam: a K8s write suspends for approval", () => {
    let server: FastifyInstance;
    let port: number;
    let cleanupDb: () => void;
    let SESSION: string;
    let K8S_TOKEN: string;
    let connK8s: RunnerConnection;
    const executedCommands: string[] = [];

    beforeAll(async () => {
      cleanupDb = useTempDb();
      SESSION = await mintTestSession();
      K8S_TOKEN = generateRunnerToken("kubernetes", "toolset-k8s-001").id;

      connK8s = registerRunner({
        runnerId: K8S_TOKEN,
        platform: "kubernetes",
        send: (raw: string) => {
          const msg = JSON.parse(raw) as RunnerCommandMessage;
          const { commandName, correlationId } = msg.payload;
          executedCommands.push(commandName);
          resolveCommand({
            correlationId,
            success: true,
            result: { success: true },
          });
        },
        close: () => {},
      });
      setRunnerManifest(
        K8S_TOKEN,
        kubernetesManifest("k8s-host", [
          kubernetesWorkload(K8S_SERVICE.namespace, K8S_SERVICE.workload),
        ]),
      );

      server = Fastify({ logger: false, forceCloseConnections: true });
      await mountApi(server, registerConsoleEventRoutes);
      await mountApi(server, registerSessionRoutes);
      await server.listen({ port: 0, host: "127.0.0.1" });
      port = (server.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      unregisterRunner(connK8s);
      await server.close();
      cleanupDb();
      vi.unstubAllEnvs();
    });

    it("RestartK8sWorkload suspends for approval before any runner dispatch", async () => {
      executedCommands.length = 0;

      setScript([
        {
          text: "Restarting K8s workload.",
          toolUses: [
            {
              id: "tu-k8s-write-1",
              name: "RestartK8sWorkload",
              input: {
                target: "kubernetes/production/api-server",
                reason: "K8s workload wedged",
                risk: "low",
                estimatedDowntimeSeconds: 10,
              },
            },
          ],
        },
        { text: "Done.", toolUses: [] },
      ]);

      const { events, close } = await connectConsoleEvents(port, SESSION);

      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Restart the K8s workload." }),
      });
      const { sessionId } = (await res.json()) as { sessionId: string };

      const interrupt = await waitFor(() =>
        events.find(
          (e) =>
            e.type === "HUMAN_INPUT_REQUIRED" &&
            e.payload["sessionId"] === sessionId,
        ),
      );

      expect(interrupt.payload["kind"]).toBe("approval");
      expect(interrupt.payload["toolName"]).toBe("RestartK8sWorkload");
      expect(executedCommands).not.toContain("RestartK8sWorkload");
      expect(hasPendingHumanInput(sessionId)).toBe(true);

      close();

      await fetch(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `nw_auth=${SESSION}`,
          },
          body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
        },
      );
      await waitFor(() => !hasPendingHumanInput(sessionId));
    });

    // A chat stays a chat. Nothing the model can call opens an investigation,
    // so the report tools stay absent for every turn of the run and for every
    // run after it.
    it("never gives a chat the report tools, on any turn or any later run", async () => {
      mockCreateProvider.mockClear();
      setScript([
        {
          text: "Let me look.",
          toolUses: [
            { id: "tu-look-1", name: "ListDockerServices", input: {} },
          ],
        },
        { text: "Redis is fine.", toolUses: [] },
      ]);

      const { events, close } = await connectConsoleEvents(port, SESSION);

      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Why does redis keep restarting?" }),
      });
      const { sessionId } = (await res.json()) as { sessionId: string };

      await waitFor(() =>
        events.find(
          (e) =>
            e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
        ),
      );
      close();

      // One provider serves the whole run, so its chat() calls are this run's
      // successive turns.
      const provider = mockCreateProvider.mock.results[0]
        ?.value as ContractFakeProvider;
      const namesOnTurn = (turn: number): string[] =>
        (provider.chat.mock.calls[turn]?.[0] as ToolSchema[]).map(
          (s) => s.name,
        );

      expect(namesOnTurn(0)).not.toContain("RecordHypothesis");
      expect(namesOnTurn(1)).not.toContain("RecordHypothesis");

      // And across runs: a follow-up on the same chat is still a chat.
      mockCreateProvider.mockClear();
      setScript([{ text: "Nothing has changed.", toolUses: [] }]);
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const followUp = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `nw_auth=${SESSION}`,
          },
          body: JSON.stringify({ message: "Anything else?" }),
        },
      );
      expect(followUp.status).toBe(202);
      await waitFor(() => !dispatcher.isSessionRunning(sessionId));

      const resumed = mockCreateProvider.mock.results[0]
        ?.value as ContractFakeProvider;
      const resumedNames = (
        resumed.chat.mock.calls[0]?.[0] as ToolSchema[]
      ).map((s) => s.name);
      expect(resumedNames).not.toContain("RecordHypothesis");
    });
  });
});
