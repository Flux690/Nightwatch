import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwarden/shared";

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
import {
  connectConsoleEvents,
  type ConsoleEventFrame,
} from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { getToolSchemas } from "../agent/tools/toolset.js";
import { currentFleetCapabilities } from "../agent/policy.js";
import { mountApi } from "./api-server.js";

const K8S_SERVICE = {
  provider: "kubernetes" as const,
  namespace: "production",
  workload: "api-server",
};

describe("toolset assembly by fleet capabilities", () => {
  describe("provider library injection (unit)", () => {
    it("capabilities: none with no runner, undefined mid-handshake, concrete once manifested", () => {
      // No runner connected: concrete all-false, so an integration-only session is
      // never offered runner tools (not the "offer everything" undefined case).
      expect(currentFleetCapabilities()).toEqual({
        docker: false,
        kubernetes: false,
      });

      const conn = registerRunner(
        "caps-unit-docker",
        () => {},
        () => {},
      );
      // Connected but manifest not arrived: undefined offers all for the handshake.
      expect(currentFleetCapabilities()).toBeUndefined();

      setRunnerManifest("caps-unit-docker", {
        hostname: "caps-unit-host",
        runnerVersion: "2.0.0",
        capabilities: {
          docker: true,
          kubernetes: false,
          services: [],
          postgres: { available: false },
          redis: { available: false },
        },
      });
      expect(currentFleetCapabilities()).toEqual({
        docker: true,
        kubernetes: false,
      });

      unregisterRunner(conn);
      expect(currentFleetCapabilities()).toEqual({
        docker: false,
        kubernetes: false,
      });
    });

    it("offers both provider libraries when capabilities are unknown", () => {
      const names = getToolSchemas().map((s) => s.name);
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("GetK8sLogs");
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("RestartK8sWorkload");
    });

    it("a Docker-only fleet gets Docker tools and no Kubernetes tools", () => {
      const names = getToolSchemas({ docker: true, kubernetes: false }).map(
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
      const names = getToolSchemas({ docker: false, kubernetes: true }).map(
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
      const dockerNames = getToolSchemas({
        docker: true,
        kubernetes: false,
      }).map((s) => s.name);
      const k8sNames = getToolSchemas({ docker: false, kubernetes: true }).map(
        (s) => s.name,
      );
      for (const name of hostTools) {
        expect(dockerNames).toContain(name);
        expect(k8sNames).not.toContain(name);
      }
    });

    it("a mixed fleet gets both libraries", () => {
      const names = getToolSchemas({ docker: true, kubernetes: true }).map(
        (s) => s.name,
      );
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

    it("GetRecentChanges is offered with no runner substrate at all", () => {
      const names = getToolSchemas(
        { docker: false, kubernetes: false },
        {
          github: true,
        },
      ).map((s) => s.name);
      expect(names).toContain("GetRecentChanges");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("GetK8sLogs");
    });

    it("the Prometheus gate controls the metrics tools, independent of substrate", () => {
      const connected = getToolSchemas(
        { docker: false, kubernetes: false },
        {
          github: false,
          prometheus: true,
        },
      ).map((s) => s.name);
      expect(connected).toContain("QueryMetrics");
      expect(connected).toContain("QueryMetricsRange");
      const disconnected = getToolSchemas(undefined, {
        prometheus: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("QueryMetrics");
      expect(disconnected).not.toContain("QueryMetricsRange");
    });

    it("the Loki gate controls the log tools, independent of substrate", () => {
      const connected = getToolSchemas(
        { docker: false, kubernetes: false },
        {
          github: false,
          prometheus: false,
          loki: true,
        },
      ).map((s) => s.name);
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
      K8S_TOKEN = generateRunnerToken("toolset-k8s-001").id;

      connK8s = registerRunner(
        K8S_TOKEN,
        (raw: string) => {
          const msg = JSON.parse(raw) as RunnerCommandMessage;
          const { commandName, correlationId } = msg.payload;
          executedCommands.push(commandName);
          resolveCommand({
            correlationId,
            success: true,
            result: { success: true },
          });
        },
        () => {},
      );
      setRunnerManifest(K8S_TOKEN, {
        hostname: "k8s-host",
        runnerVersion: "2.0.0",
        capabilities: {
          docker: false,
          kubernetes: true,
          services: [
            {
              identity: K8S_SERVICE,
              status: "running",
            },
          ],
          postgres: { available: false },
          redis: { available: false },
        },
      });

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
                rationale: "K8s workload wedged",
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
  });
});
