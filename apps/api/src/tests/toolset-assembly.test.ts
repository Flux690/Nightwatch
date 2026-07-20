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
import { getToolSchemas } from "../agent/tools/toolset.js";

const K8S_SERVICE = {
  provider: "kubernetes" as const,
  namespace: "production",
  workload: "api-server",
};

describe("toolset assembly by fleet capabilities and remediation mode", () => {
  describe("provider library injection (unit)", () => {
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
      const connected = getToolSchemas(undefined, true, { github: true }).map(
        (s) => s.name,
      );
      expect(connected).toContain("GetRecentChanges");
      expect(connected).toContain("OpenPullRequest");
      const disconnected = getToolSchemas(undefined, true, {
        github: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("GetRecentChanges");
      expect(disconnected).not.toContain("OpenPullRequest");
      expect(disconnected).not.toContain("Read");
    });

    it("GetRecentChanges is offered with no runner substrate at all", () => {
      const names = getToolSchemas({ docker: false, kubernetes: false }, true, {
        github: true,
      }).map((s) => s.name);
      expect(names).toContain("GetRecentChanges");
      expect(names).not.toContain("GetDockerLogs");
      expect(names).not.toContain("GetK8sLogs");
    });

    it("the Prometheus gate controls the metrics tools, independent of substrate", () => {
      const connected = getToolSchemas(
        { docker: false, kubernetes: false },
        true,
        {
          github: false,
          prometheus: true,
        },
      ).map((s) => s.name);
      expect(connected).toContain("QueryMetrics");
      expect(connected).toContain("QueryMetricsRange");
      const disconnected = getToolSchemas(undefined, true, {
        prometheus: false,
      }).map((s) => s.name);
      expect(disconnected).not.toContain("QueryMetrics");
      expect(disconnected).not.toContain("QueryMetricsRange");
    });

    it("the Loki gate controls the log tools, independent of substrate", () => {
      const connected = getToolSchemas(
        { docker: false, kubernetes: false },
        true,
        {
          github: false,
          prometheus: false,
          loki: true,
        },
      ).map((s) => s.name);
      expect(connected).toContain("QueryLogs");
      expect(connected).toContain("QueryLogMetrics");
      expect(connected).toContain("DiscoverLogLabels");
      const disconnected = getToolSchemas(undefined, true, { loki: false }).map(
        (s) => s.name,
      );
      expect(disconnected).not.toContain("QueryLogs");
      expect(disconnected).not.toContain("QueryLogMetrics");
      expect(disconnected).not.toContain("DiscoverLogLabels");
    });
  });

  describe("remediation-mode filter (unit)", () => {
    it("omits write tools when remediation is off", () => {
      const names = getToolSchemas(undefined, false).map((s) => s.name);
      expect(names).not.toContain("RestartDockerService");
      expect(names).not.toContain("DockerBash");
      expect(names).not.toContain("RestartK8sWorkload");
      expect(names).not.toContain("K8sBash");
      expect(names).toContain("GetDockerLogs");
      expect(names).toContain("ListDockerServices");
    });

    it("includes write tools when remediation is on", () => {
      const names = getToolSchemas(undefined, true).map((s) => s.name);
      expect(names).toContain("RestartDockerService");
      expect(names).toContain("DockerBash");
      expect(names).toContain("RestartK8sWorkload");
      expect(names).toContain("K8sBash");
    });

    it("combines provider and remediation filters", () => {
      const names = getToolSchemas(
        { docker: true, kubernetes: false },
        false,
      ).map((s) => s.name);
      expect(names).not.toContain("RestartDockerService");
      expect(names).not.toContain("DockerBash");
      expect(names).not.toContain("GetK8sLogs");
      expect(names).toContain("GetDockerLogs");
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
      expect(interrupt.payload["toolName"]).toBe("RestartK8sWorkload");
      expect(executedCommands).not.toContain("RestartK8sWorkload");
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
  });

  describe("agentic loop seam: read-only mode strips writes from the offered schema", () => {
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
      RO_TOKEN = generateRunnerToken("toolset-ro-001").id;

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

    it("system prompt states read-only mode and write tools are absent", async () => {
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
        Array<{ name: string }> | undefined;
      expect(toolsPassedToChat).toBeDefined();
      const offeredNames = toolsPassedToChat!.map((s) => s.name);
      expect(offeredNames).not.toContain("RestartDockerService");
      expect(offeredNames).not.toContain("DockerBash");
      expect(offeredNames).toContain("GetDockerLogs");

      close();
    });

    it("a write the model emits anyway is unavailable, not an approval card", async () => {
      // Read-only mode strips RestartDockerService from the schema; the model emits it anyway
      // (LLMs hallucinate stripped names), and the loop resolves against that same effective set.
      const { events, close } = await connectConsoleEvents(port, SESSION);

      setScript([
        {
          text: "Restarting.",
          toolUses: [
            {
              id: "tu-ro-bypass",
              name: "RestartDockerService",
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
          if (e.type !== "MESSAGE") return false;
          const message = e.payload["message"] as { content?: string };
          return message.content === "Investigation complete.";
        }),
      );

      expect(events.some((e) => e.type === "HUMAN_INPUT_REQUIRED")).toBe(false);
      expect(hasPendingHumanInput(sessionId)).toBe(false);

      close();
    });
  });

  describe("agentic loop seam: DB stored remediation value overrides manifest", () => {
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
        Array<{ name: string }> | undefined;
      return (toolsPassedToChat ?? []).map((s) => s.name);
    }

    it("DB mode false suppresses writes even when the manifest reports remediation on", async () => {
      const { id: runnerId } = generateRunnerToken("db-mode-false-001");
      const offered = await runChatAndCaptureTools(runnerId, true, false);
      expect(offered).not.toContain("RestartDockerService");
      expect(offered).not.toContain("DockerBash");
      expect(offered).toContain("GetDockerLogs");
    });

    it("DB mode true offers writes even when the manifest reports remediation off", async () => {
      const { id: runnerId } = generateRunnerToken("db-mode-true-001");
      const offered = await runChatAndCaptureTools(runnerId, false, true);
      expect(offered).toContain("RestartDockerService");
      expect(offered).toContain("DockerBash");
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
            name: "RestartDockerService",
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
            name: "RestartDockerService",
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
