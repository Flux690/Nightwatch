import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwatch/shared";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

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
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerSessionRoutes } from "../session/routes.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";
import { TOOL_REGISTRY, getToolSchemas } from "../agent/tools.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

function waitForConnected(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMsg = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "connected") {
        ws.off("message", onMsg);
        resolve();
      }
    };
    ws.on("message", onMsg);
  });
}

const K8S_SERVICE = {
  provider: "kubernetes" as const,
  namespace: "production",
  workload: "api-server",
};

const DOCKER_SERVICE = {
  provider: "docker" as const,
  project: "myapp",
  service: "web",
};

describe("providers filter and mismatch rejection", () => {
  describe("getToolSchemas provider filtering (unit)", () => {
    it("includes all tools when no providers set is given", () => {
      const schemas = getToolSchemas();
      const names = schemas.map((s) => s.name);
      expect(names).toContain("get_service_logs");
      expect(names).toContain("restart_service");
      expect(names).toContain("get_k8s_rollout_status");
    });

    it("excludes K8s-only tools from a Docker-only fleet", () => {
      const schemas = getToolSchemas(new Set(["docker"]));
      const names = schemas.map((s) => s.name);
      expect(names).not.toContain("get_k8s_rollout_status");
      expect(names).toContain("get_service_logs");
      expect(names).toContain("restart_service");
    });

    it("includes K8s-only tools for a Kubernetes-only fleet", () => {
      const schemas = getToolSchemas(new Set(["kubernetes"]));
      const names = schemas.map((s) => s.name);
      expect(names).toContain("get_k8s_rollout_status");
      expect(names).toContain("get_service_logs");
    });

    it("includes K8s-only tools for a mixed fleet", () => {
      const schemas = getToolSchemas(new Set(["docker", "kubernetes"]));
      const names = schemas.map((s) => s.name);
      expect(names).toContain("get_k8s_rollout_status");
      expect(names).toContain("get_service_logs");
    });

    it("get_k8s_rollout_status is registered as kubernetes-only in the registry", () => {
      const entry = TOOL_REGISTRY.find(
        (t) => t.schema.name === "get_k8s_rollout_status",
      );
      expect(entry).toBeDefined();
      expect(entry!.providers).toEqual(["kubernetes"]);
      expect(entry!.access).toBe("read");
    });

    it("host tools are Docker-scoped: absent on a Kubernetes-only fleet, present on Docker", () => {
      const hostTools = [
        "get_host_memory",
        "get_host_cpu",
        "get_host_disk",
        "get_host_network",
        "get_host_dmesg",
      ];

      const k8sNames = getToolSchemas(new Set(["kubernetes"])).map(
        (s) => s.name,
      );
      const dockerNames = getToolSchemas(new Set(["docker"])).map(
        (s) => s.name,
      );

      for (const name of hostTools) {
        expect(k8sNames).not.toContain(name);
        expect(dockerNames).toContain(name);
      }
    });

    it("get_k8s_node_status is Kubernetes-only: present on a K8s fleet, absent on Docker", () => {
      const k8sNames = getToolSchemas(new Set(["kubernetes"])).map(
        (s) => s.name,
      );
      const dockerNames = getToolSchemas(new Set(["docker"])).map(
        (s) => s.name,
      );
      expect(k8sNames).toContain("get_k8s_node_status");
      expect(dockerNames).not.toContain("get_k8s_node_status");

      const entry = TOOL_REGISTRY.find(
        (t) => t.schema.name === "get_k8s_node_status",
      );
      expect(entry!.providers).toEqual(["kubernetes"]);
      expect(entry!.access).toBe("read");
    });

    it("agnostic tools carry no providers annotation (absent means all)", () => {
      const agnostic = TOOL_REGISTRY.find(
        (t) => t.schema.name === "get_service_logs",
      );
      expect(agnostic!.providers).toBeUndefined();
    });

    it("get_recent_deploys is not offered (deferred, like rollback_deploy)", () => {
      expect(
        TOOL_REGISTRY.find((t) => t.schema.name === "get_recent_deploys"),
      ).toBeUndefined();
      expect(getToolSchemas().map((s) => s.name)).not.toContain(
        "get_recent_deploys",
      );
    });
  });

  describe("agentic loop seam: K8s writes and mismatch rejection", () => {
    let server: FastifyInstance;
    let port: number;
    let cleanupDb: () => void;
    let SESSION: string;
    let K8S_TOKEN: string;
    const executedCommands: string[] = [];

    beforeAll(async () => {
      cleanupDb = useTempDb();
      SESSION = await mintTestSession();
      K8S_TOKEN = generateRunnerToken("providers-filter-k8s-001").id;

      registerRunner(
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
        runnerId: "runner-providers-k8s",
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
          prometheus: { available: false },
          postgres: { available: false },
          redis: { available: false },
          hostMetrics: false,
          fileRead: false,
          remediationEnabled: true,
        },
      });

      server = Fastify({ logger: false });
      await server.register(FastifyWebSocket);
      await registerConsoleWsRoutes(server);
      await registerSessionRoutes(server);
      await server.listen({ port: 0, host: "127.0.0.1" });
      port = (server.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      unregisterRunner(K8S_TOKEN);
      await server.close();
      cleanupDb();
      vi.unstubAllEnvs();
    });

    it("K8s restart_service still suspends for approval (write gate holds on K8s fleet)", async () => {
      executedCommands.length = 0;

      setScript([
        {
          text: "Restarting K8s workload.",
          toolUses: [
            {
              id: "tu-k8s-write-1",
              name: "restart_service",
              input: {
                service: K8S_SERVICE,
                rationale: "K8s workload wedged",
                risk: "low",
                estimatedDowntimeSeconds: 10,
              },
            },
          ],
        },
        { text: "Done.", toolUses: [] },
      ]);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
        headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
      });
      const events: WsEvent[] = [];
      ws.on("message", (raw) => {
        events.push(JSON.parse(raw.toString()) as WsEvent);
      });
      await waitForConnected(ws);

      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
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
      expect(interrupt.payload["toolName"]).toBe("restart_service");
      expect(executedCommands).not.toContain("restart_container");
      expect(hasPendingHumanInput(sessionId)).toBe(true);

      ws.close();

      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
      });
      await waitFor(() => !hasPendingHumanInput(sessionId));
    });

    it("mismatch rejection: K8s-only tool called with a Docker service returns corrective error, loop continues", async () => {
      setScript([
        {
          text: "Checking rollout status.",
          toolUses: [
            {
              id: "tu-mismatch-1",
              name: "get_k8s_rollout_status",
              input: {
                service: DOCKER_SERVICE,
              },
            },
          ],
        },
        { text: "Investigation complete.", toolUses: [] },
      ]);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
        headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
      });
      const events: WsEvent[] = [];
      ws.on("message", (raw) => {
        events.push(JSON.parse(raw.toString()) as WsEvent);
      });
      await waitForConnected(ws);

      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Check rollout status." }),
      });
      expect(res.status).toBe(202);
      const { sessionId } = (await res.json()) as { sessionId: string };

      // Mismatch is rejected before any runner dispatch, so the run never
      // suspends and reaches the free-form finish in the scripted second turn.
      await waitFor(() =>
        events.some((e) => {
          if (e.type !== "RUN_FINISHED") return false;
          const message = e.payload["message"] as { content?: string };
          return message.content === "Investigation complete.";
        }),
      );

      // The tool_result fed back to the model carries the corrective error,
      // not a runner-executed result.
      const messages = getSessionMessages(sessionId);
      const toolResultMessage = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.includes("Provider mismatch") &&
          m.content.includes("get_k8s_rollout_status"),
      );
      expect(toolResultMessage).toBeDefined();

      // No suspension should have occurred
      expect(hasPendingHumanInput(sessionId)).toBe(false);

      ws.close();
    });
  });

  describe("remediation-mode filter", () => {
    describe("getToolSchemas remediation filtering (unit)", () => {
      it("omits write tools when remediationEnabled is false", () => {
        const schemas = getToolSchemas(undefined, false);
        const names = schemas.map((s) => s.name);
        expect(names).not.toContain("restart_service");
        expect(names).not.toContain("exec_command");
        expect(names).toContain("get_service_logs");
        expect(names).toContain("list_services");
      });

      it("includes write tools when remediationEnabled is true", () => {
        const schemas = getToolSchemas(undefined, true);
        const names = schemas.map((s) => s.name);
        expect(names).toContain("restart_service");
        expect(names).toContain("exec_command");
      });

      it("includes write tools when remediationEnabled is absent (backward compat)", () => {
        const schemas = getToolSchemas();
        const names = schemas.map((s) => s.name);
        expect(names).toContain("restart_service");
        expect(names).toContain("exec_command");
      });

      it("combines provider filter and remediation filter correctly", () => {
        const schemas = getToolSchemas(new Set(["docker"]), false);
        const names = schemas.map((s) => s.name);
        expect(names).not.toContain("restart_service");
        expect(names).not.toContain("exec_command");
        expect(names).not.toContain("get_k8s_rollout_status");
        expect(names).toContain("get_service_logs");
      });
    });

    describe("agentic loop seam: read-only mode propagation", () => {
      let server: FastifyInstance;
      let port: number;
      let cleanupDb: () => void;
      let SESSION: string;
      let RO_TOKEN: string;

      const RO_SERVICE = {
        provider: "docker" as const,
        project: "ro-app",
        service: "ro-svc",
      };

      beforeAll(async () => {
        cleanupDb = useTempDb();
        SESSION = await mintTestSession();
        RO_TOKEN = generateRunnerToken("remediation-mode-ro-001").id;

        registerRunner(
          RO_TOKEN,
          () => {},
          () => {},
        );
        setRunnerManifest(RO_TOKEN, {
          runnerId: "runner-remediation-mode-ro",
          hostname: "ro-host",
          runnerVersion: "2.0.0",
          capabilities: {
            docker: true,
            kubernetes: false,
            services: [{ identity: RO_SERVICE, status: "running" }],
            prometheus: { available: false },
            postgres: { available: false },
            redis: { available: false },
            hostMetrics: false,
            fileRead: false,
            remediationEnabled: false,
          },
        });

        server = Fastify({ logger: false });
        await server.register(FastifyWebSocket);
        await registerConsoleWsRoutes(server);
        await registerSessionRoutes(server);
        await server.listen({ port: 0, host: "127.0.0.1" });
        port = (server.server.address() as AddressInfo).port;
      });

      afterAll(async () => {
        unregisterRunner(RO_TOKEN);
        await server.close();
        cleanupDb();
        vi.unstubAllEnvs();
      });

      it("system prompt states read-only mode and write tools are absent from the offered schema", async () => {
        let capturedProvider: ContractFakeProvider | null = null;
        mockCreateProvider.mockImplementationOnce(() => {
          const p = scriptRunner.create();
          capturedProvider = p;
          return p;
        });

        setScript([{ text: "Investigating in read-only mode.", toolUses: [] }]);

        const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
          headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
        });
        const events: WsEvent[] = [];
        ws.on("message", (raw) => {
          events.push(JSON.parse(raw.toString()) as WsEvent);
        });
        await waitForConnected(ws);

        const res = await fetch(`http://127.0.0.1:${port}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `nw_auth=${SESSION}`,
          },
          body: JSON.stringify({ message: "What is going on?" }),
        });
        expect(res.status).toBe(202);

        await waitFor(() => events.some((e) => e.type === "RUN_FINISHED"));

        expect(mockCreateProvider).toHaveBeenCalled();
        const systemPromptArg = mockCreateProvider.mock.lastCall?.[0] as string;
        expect(systemPromptArg.toLowerCase()).toContain("read-only");
        expect(systemPromptArg).toContain("REMEDIATION_ENABLED");

        expect(capturedProvider).not.toBeNull();
        const toolsPassedToChat = capturedProvider!.chat.mock.calls[0]?.[0] as
          | Array<{ name: string }>
          | undefined;
        expect(toolsPassedToChat).toBeDefined();
        const offeredNames = toolsPassedToChat!.map((s) => s.name);
        expect(offeredNames).not.toContain("restart_service");
        expect(offeredNames).not.toContain("exec_command");
        expect(offeredNames).toContain("get_service_logs");

        ws.close();
      });
    });
  });
});
