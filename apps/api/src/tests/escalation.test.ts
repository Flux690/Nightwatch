import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type {
  NormalizedAlert,
  RunnerCommandMessage,
} from "@nightwarden/shared";

import {
  createContractFakeProvider,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { connectConsoleEvents } from "./console-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { getTranscriptRows } from "../db/sessions.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { mountApi } from "./api-server.js";
import { dockerService } from "./manifest-helper.js";

describe("termination paths: every run ends in model text, no escalation", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("docker", "test-esc-runner").id;

    conn = registerRunner({
      runnerId: TEST_TOKEN,
      platform: "docker",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { correlationId } = msg.payload;
        resolveCommand({ correlationId, success: true, result: [] });
      },
      close: () => {},
    });
    setRunnerManifest(TEST_TOKEN, {
      platform: "docker",
      hostname: "esc-host",
      runnerVersion: "2.0.0",
      services: [dockerService("web-01")],
    });

    server = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(server, registerConsoleEventRoutes);
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("model refusal ends on model's own text: no synthetic message, no ESCALATED", async () => {
    const refusalScript: ScriptedTurn[] = [
      { toolUses: [], text: "I cannot help with that.", stopReason: "refusal" },
    ];
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(refusalScript),
    );

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Do something dangerous." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "MESSAGE" &&
          e.payload["sessionId"] === sessionId &&
          (e.payload["message"] as { kind?: string } | undefined)?.kind ===
            "assistant",
      ),
    );
    close();

    const messages = getTranscriptRows(sessionId);
    const lastAssistant = messages.filter((m) => m.kind === "assistant").pop();
    expect(lastAssistant?.content).toBe("I cannot help with that.");
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);
  });

  it("free-form text finish: model text is the answer, no escalation", async () => {
    const finishScript: ScriptedTurn[] = [
      { toolUses: [], text: "Root cause found. I am done." },
    ];
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(finishScript),
    );

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Wrap up." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "MESSAGE" &&
          e.payload["sessionId"] === sessionId &&
          (
            e.payload["message"] as
              { role?: string; content?: string } | undefined
          )?.content === "Root cause found. I am done.",
      ),
    );
    close();

    const messages = getTranscriptRows(sessionId);
    const lastAssistant = messages.filter((m) => m.kind === "assistant").pop();
    expect(lastAssistant?.content).toBe("Root cause found. I am done.");
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);
  });

  it("critical rejection resumes with coherent transcript: no escalation, model continues", async () => {
    const toolUseId = `tu-crit-${randomUUID()}`;

    const firstRunScript: ScriptedTurn[] = [
      {
        toolUses: [
          {
            id: toolUseId,
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
            },
          },
        ],
        text: "Need to restart.",
      },
    ];
    const resumeScript: ScriptedTurn[] = [
      {
        toolUses: [],
        text: "Understood. The restart was rejected. Here is my analysis.",
      },
    ];
    mockCreateProvider
      .mockImplementationOnce(() => createContractFakeProvider(firstRunScript))
      .mockImplementationOnce(() => createContractFakeProvider(resumeScript));

    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-${randomUUID()}`,
      labels: {},
      alertType: "ContainerDown",
      severity: "critical",
      firedAt: new Date().toISOString(),
      annotations: {},
      generatorURL: null,
      rawPayload: {},
    };

    const { events, close } = await connectConsoleEvents(port, SESSION);

    dispatcher.dispatch({ alerts: [alert], sessionId });

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "reject",
          text: "too risky",
          resolvedBy: "test",
        }),
      },
    );
    expect(rejectRes.status).toBe(200);

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "MESSAGE" &&
          e.payload["sessionId"] === sessionId &&
          (
            e.payload["message"] as
              { role?: string; content?: string } | undefined
          )?.content ===
            "Understood. The restart was rejected. Here is my analysis.",
      ),
    );
    close();

    const messages = getTranscriptRows(sessionId);
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);

    const lastAssistant = messages.filter((m) => m.kind === "assistant").pop();
    expect(lastAssistant?.content).toContain("rejected");
  });
});
