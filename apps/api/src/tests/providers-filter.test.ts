import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwatch/shared";

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

import { generateRunnerToken, setRemediationMode } from "../db/runner.js";
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
  setRunnerRemediationMode,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { TOOL_REGISTRY, getToolSchemas } from "../agent/tools/toolset.js";

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
      expect(names).toContain("GetServiceLogs");
      expect(names).toContain("RestartService");
      expect(names).toContain("GetK8sRolloutStatus");
    });

    it("excludes K8s-only tools from a Docker-only fleet", () => {
      const schemas = getToolSchemas(new Set(["docker"]));
      const names = schemas.map((s) => s.name);
      expect(names).not.toContain("GetK8sRolloutStatus");
      expect(names).toContain("GetServiceLogs");
      expect(names).toContain("RestartService");
    });

    it("includes K8s-only tools for a Kubernetes-only fleet", () => {
      const schemas = getToolSchemas(new Set(["kubernetes"]));
      const names = schemas.map((s) => s.name);
      expect(names).toContain("GetK8sRolloutStatus");
      expect(names).toContain("GetServiceLogs");
    });

    it("includes K8s-only tools for a mixed fleet", () => {
      const schemas = getToolSchemas(new Set(["docker", "kubernetes"]));
      const names = schemas.map((s) => s.name);
      expect(names).toContain("GetK8sRolloutStatus");
      expect(names).toContain("GetServiceLogs");
    });

    it("GetK8sRolloutStatus is registered as kubernetes-only in the registry", () => {
      const entry = TOOL_REGISTRY.find(
        (t) => t.schema.name === "GetK8sRolloutStatus",
      );
      expect(entry).toBeDefined();
      expect(entry!.providers).toEqual(["kubernetes"]);
      expect(entry!.access).toBe("read");
    });

    it("host tools are Docker-scoped: absent on a Kubernetes-only fleet, present on Docker", () => {
      const hostTools = [
        "GetHostMemory",
        "GetHostCPU",
        "GetHostDisk",
        "GetHostNetwork",
        "GetHostDmesg",
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

    it("GetK8sNodeStatus is Kubernetes-only: present on a K8s fleet, absent on Docker", () => {
      const k8sNames = getToolSchemas(new Set(["kubernetes"])).map(
        (s) => s.name,
      );
      const dockerNames = getToolSchemas(new Set(["docker"])).map(
        (s) => s.name,
      );
      expect(k8sNames).toContain("GetK8sNodeStatus");
      expect(dockerNames).not.toContain("GetK8sNodeStatus");

      const entry = TOOL_REGISTRY.find(
        (t) => t.schema.name === "GetK8sNodeStatus",
      );
      expect(entry!.providers).toEqual(["kubernetes"]);
      expect(entry!.access).toBe("read");
    });

    it("agnostic tools carry no providers annotation (absent means all)", () => {
      const agnostic = TOOL_REGISTRY.find(
        (t) => t.schema.name === "GetServiceLogs",
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
    let connK8s: RunnerConnection;
    const executedCommands: string[] = [];

    beforeAll(async () => {
      cleanupDb = useTempDb();
      SESSION = await mintTestSession();
      K8S_TOKEN = generateRunnerToken("providers-filter-k8s-001").id;

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
          hostMetrics: false,
          fileRead: false,
          remediationEnabled: true,
        },
      });

      server = Fastify({ logger: false, forceCloseConnections: true });
      await registerConsoleEventRoutes(server);
      await registerSessionRoutes(server);
      await server.listen({ port: 0, host: "127.0.0.1" });
      port = (server.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      unregisterRunner(connK8s);
      await server.close();
      cleanupDb();
      vi.unstubAllEnvs();
    });

    it("K8s RestartService still suspends for approval (write gate holds on K8s fleet)", async () => {
      executedCommands.length = 0;

      setScript([
        {
          text: "Restarting K8s workload.",
          toolUses: [
            {
              id: "tu-k8s-write-1",
              name: "RestartService",
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

      const { events, close } = await connectConsoleEvents(port, SESSION);

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
      expect(interrupt.payload["toolName"]).toBe("RestartService");
      expect(executedCommands).not.toContain("RestartService");
      expect(hasPendingHumanInput(sessionId)).toBe(true);

      close();

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
              name: "GetK8sRolloutStatus",
              input: {
                service: DOCKER_SERVICE,
              },
            },
          ],
        },
        { text: "Investigation complete.", toolUses: [] },
      ]);

      const { events, close } = await connectConsoleEvents(port, SESSION);

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
          m.content.includes("GetK8sRolloutStatus"),
      );
      expect(toolResultMessage).toBeDefined();

      // No suspension should have occurred
      expect(hasPendingHumanInput(sessionId)).toBe(false);

      close();
    });
  });

  describe("remediation-mode filter", () => {
    describe("getToolSchemas remediation filtering (unit)", () => {
      it("omits write tools when remediationEnabled is false", () => {
        const schemas = getToolSchemas(undefined, false);
        const names = schemas.map((s) => s.name);
        expect(names).not.toContain("RestartService");
        expect(names).not.toContain("ServiceBash");
        expect(names).toContain("GetServiceLogs");
        expect(names).toContain("ListServices");
      });

      it("includes write tools when remediationEnabled is true", () => {
        const schemas = getToolSchemas(undefined, true);
        const names = schemas.map((s) => s.name);
        expect(names).toContain("RestartService");
        expect(names).toContain("ServiceBash");
      });

      it("includes write tools when remediationEnabled is absent (backward compat)", () => {
        const schemas = getToolSchemas();
        const names = schemas.map((s) => s.name);
        expect(names).toContain("RestartService");
        expect(names).toContain("ServiceBash");
      });

      it("combines provider filter and remediation filter correctly", () => {
        const schemas = getToolSchemas(new Set(["docker"]), false);
        const names = schemas.map((s) => s.name);
        expect(names).not.toContain("RestartService");
        expect(names).not.toContain("ServiceBash");
        expect(names).not.toContain("GetK8sRolloutStatus");
        expect(names).toContain("GetServiceLogs");
      });
    });

    describe("agentic loop seam: read-only mode propagation", () => {
      let server: FastifyInstance;
      let port: number;
      let cleanupDb: () => void;
      let SESSION: string;
      let RO_TOKEN: string;
      let connRO: RunnerConnection;

      const RO_SERVICE = {
        provider: "docker" as const,
        project: "ro-app",
        service: "ro-svc",
      };

      beforeAll(async () => {
        cleanupDb = useTempDb();
        SESSION = await mintTestSession();
        RO_TOKEN = generateRunnerToken("remediation-mode-ro-001").id;

        connRO = registerRunner(
          RO_TOKEN,
          () => {},
          () => {},
        );
        setRunnerManifest(RO_TOKEN, {
          hostname: "ro-host",
          runnerVersion: "2.0.0",
          capabilities: {
            docker: true,
            kubernetes: false,
            services: [{ identity: RO_SERVICE, status: "running" }],
            postgres: { available: false },
            redis: { available: false },
            hostMetrics: false,
            fileRead: false,
            remediationEnabled: false,
          },
        });

        server = Fastify({ logger: false, forceCloseConnections: true });
        await registerConsoleEventRoutes(server);
        await registerSessionRoutes(server);
        await server.listen({ port: 0, host: "127.0.0.1" });
        port = (server.server.address() as AddressInfo).port;
      });

      afterAll(async () => {
        unregisterRunner(connRO);
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

        const { events, close } = await connectConsoleEvents(port, SESSION);

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
        expect(systemPromptArg).toContain("remediation from the console");

        expect(capturedProvider).not.toBeNull();
        const toolsPassedToChat = capturedProvider!.chat.mock.calls[0]?.[0] as
          | Array<{ name: string }>
          | undefined;
        expect(toolsPassedToChat).toBeDefined();
        const offeredNames = toolsPassedToChat!.map((s) => s.name);
        expect(offeredNames).not.toContain("RestartService");
        expect(offeredNames).not.toContain("ServiceBash");
        expect(offeredNames).toContain("GetServiceLogs");

        close();
      });

      it("a write the model emits anyway is unavailable, not an approval card (gate cannot be bypassed)", async () => {
        // Read-only mode strips RestartService from the schema; the model emits it anyway (LLMs
        // hallucinate stripped names), and the loop resolves against that same effective set.
        const { events, close } = await connectConsoleEvents(port, SESSION);

        setScript([
          {
            text: "Restarting.",
            toolUses: [
              {
                id: "tu-ro-bypass",
                name: "RestartService",
                input: {
                  service: RO_SERVICE,
                  rationale: "r",
                  risk: "low",
                  estimatedDowntimeSeconds: 1,
                },
              },
            ],
          },
          { text: "Investigation complete.", toolUses: [] },
        ]);

        const res = await fetch(`http://127.0.0.1:${port}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `nw_auth=${SESSION}`,
          },
          body: JSON.stringify({ message: "restart the service" }),
        });
        const { sessionId } = (await res.json()) as { sessionId: string };

        await waitFor(() =>
          events.some((e) => {
            if (e.type !== "RUN_FINISHED") return false;
            const message = e.payload["message"] as { content?: string };
            return message.content === "Investigation complete.";
          }),
        );

        // No approval card was raised for the stripped write, and nothing is
        // pending: it resolved as an unavailable tool, not a gated action.
        expect(events.some((e) => e.type === "HUMAN_INPUT_REQUIRED")).toBe(
          false,
        );
        expect(hasPendingHumanInput(sessionId)).toBe(false);

        close();
      });
    });

    describe("agentic loop seam: DB stored value overrides manifest", () => {
      let server: FastifyInstance;
      let port: number;
      let cleanupDb: () => void;
      let SESSION: string;

      const DB_SERVICE = {
        provider: "docker" as const,
        project: "db-mode-app",
        service: "db-mode-svc",
      };

      beforeAll(async () => {
        cleanupDb = useTempDb();
        SESSION = await mintTestSession();
      });

      afterAll(async () => {
        await server?.close();
        cleanupDb();
      });

      async function runChatAndCaptureTools(
        runnerId: string,
        manifestRemediationEnabled: boolean,
        dbRemediationEnabled: boolean,
      ): Promise<string[]> {
        setRemediationMode(runnerId, dbRemediationEnabled);

        const conn = registerRunner(
          runnerId,
          () => {},
          () => {},
        );
        setRunnerManifest(runnerId, {
          hostname: "db-mode-host",
          runnerVersion: "2.0.0",
          capabilities: {
            docker: true,
            kubernetes: false,
            services: [{ identity: DB_SERVICE, status: "running" }],
            postgres: { available: false },
            redis: { available: false },
            hostMetrics: false,
            fileRead: false,
            remediationEnabled: manifestRemediationEnabled,
          },
        });
        // Simulate what ws/server.ts reconciliation does: sync the DB value
        // into the in-memory cache so currentRemediationEnabled() reads it.
        setRunnerRemediationMode(runnerId, dbRemediationEnabled);

        let capturedProvider: ContractFakeProvider | null = null;
        mockCreateProvider.mockImplementationOnce(() => {
          const p = scriptRunner.create();
          capturedProvider = p;
          return p;
        });
        setScript([{ text: "Done.", toolUses: [] }]);

        const s = Fastify({ logger: false, forceCloseConnections: true });
        await registerConsoleEventRoutes(s);
        await registerSessionRoutes(s);
        await s.listen({ port: 0, host: "127.0.0.1" });
        const p = (s.server.address() as AddressInfo).port;
        server = s;

        const { events, close } = await connectConsoleEvents(p, SESSION);

        await fetch(`http://127.0.0.1:${p}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `nw_auth=${SESSION}`,
          },
          body: JSON.stringify({ message: "Check the service." }),
        });

        await waitFor(() => events.some((e) => e.type === "RUN_FINISHED"));
        close();
        await s.close();
        unregisterRunner(conn);

        const toolsPassedToChat = capturedProvider!.chat.mock.calls[0]?.[0] as
          | Array<{ name: string }>
          | undefined;
        return (toolsPassedToChat ?? []).map((s) => s.name);
      }

      it("DB mode false suppresses write tools even when manifest reports remediationEnabled:true", async () => {
        const { id: runnerId } = generateRunnerToken("db-mode-false-001");
        const offered = await runChatAndCaptureTools(runnerId, true, false);
        expect(offered).not.toContain("RestartService");
        expect(offered).not.toContain("ServiceBash");
        expect(offered).toContain("GetServiceLogs");
      });

      it("DB mode true offers write tools even when manifest reports remediationEnabled:false", async () => {
        const { id: runnerId } = generateRunnerToken("db-mode-true-001");
        const offered = await runChatAndCaptureTools(runnerId, false, true);
        expect(offered).toContain("RestartService");
        expect(offered).toContain("ServiceBash");
      });
    });
  });
});

describe("per-target write gating", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let connOn: RunnerConnection;
  let connOff: RunnerConnection;

  const ON_SERVICE = {
    provider: "docker" as const,
    project: "gated-on-app",
    service: "on-svc",
  };
  const OFF_SERVICE = {
    provider: "docker" as const,
    project: "gated-off-app",
    service: "off-svc",
  };

  function gatedManifest(
    hostname: string,
    service: typeof ON_SERVICE,
    remediationEnabled: boolean,
  ) {
    return {
      hostname,
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [{ identity: service, status: "running" }],
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: false,
        fileRead: false,
        remediationEnabled,
      },
    };
  }

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    const onId = generateRunnerToken("gated-on-001", "gated-on").id;
    const offId = generateRunnerToken("gated-off-001", "gated-off").id;
    setRemediationMode(onId, true);
    setRemediationMode(offId, false);

    connOn = registerRunner(
      onId,
      () => {},
      () => {},
      "gated-on",
    );
    setRunnerManifest(onId, gatedManifest("gated-on-host", ON_SERVICE, true));
    setRunnerRemediationMode(onId, true);

    connOff = registerRunner(
      offId,
      () => {},
      () => {},
      "gated-off",
    );
    setRunnerManifest(
      offId,
      gatedManifest("gated-off-host", OFF_SERVICE, false),
    );
    setRunnerRemediationMode(offId, false);

    server = Fastify({ logger: false, forceCloseConnections: true });
    await registerConsoleEventRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(connOn);
    unregisterRunner(connOff);
    await server.close();
    cleanupDb();
  });

  async function chatSession(message: string): Promise<{
    sessionId: string;
    events: ConsoleEventFrame[];
    close: () => void;
  }> {
    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { sessionId, events, close };
  }

  it("a write against a remediation-off server is refused before waking a human", async () => {
    setScript([
      {
        text: "Restarting off-svc.",
        toolUses: [
          {
            id: "tu-gated-off",
            name: "RestartService",
            input: {
              service: OFF_SERVICE,
              rationale: "wedged",
              risk: "low",
              estimatedDowntimeSeconds: 3,
            },
          },
        ],
      },
      { text: "Understood, recommending instead.", toolUses: [] },
    ]);

    const { sessionId, events, close } = await chatSession(
      "off-svc looks wedged, restart it",
    );
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );

    // No approval card was ever raised - the gate rejected at proposal time.
    expect(
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    const messages = getSessionMessages(sessionId);
    const rejection = messages.find(
      (m) =>
        m.role === "user" && m.content.includes("Remediation is disabled on"),
    );
    expect(rejection?.content).toContain("gated-off");

    close();
  });

  it("a write against a remediation-on server still raises the approval card", async () => {
    setScript([
      {
        text: "Restarting on-svc.",
        toolUses: [
          {
            id: "tu-gated-on",
            name: "RestartService",
            input: {
              service: ON_SERVICE,
              rationale: "wedged",
              risk: "low",
              estimatedDowntimeSeconds: 3,
            },
          },
        ],
      },
      { text: "Done.", toolUses: [] },
    ]);

    const { sessionId, events, close } = await chatSession(
      "on-svc looks wedged, restart it",
    );
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    close();
  });
});
