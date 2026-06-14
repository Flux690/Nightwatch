import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Scripted provider: each chat() call parks until releaseNext() is called,
// then resolves with the next turn in the script. snapshot() accumulates
// messages so persist() inside the loop writes real session_message rows.
const { mockCreateProvider, releaseNext, releaseAll, setTurns } = vi.hoisted(
  () => {
    type ToolUseItem = {
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
    type Turn = { toolUses: ToolUseItem[]; text: string };

    let turns: Turn[] = [];
    let turnIndex = 0;
    const gates: Array<() => void> = [];

    const make = () => {
      const messages: Array<{
        role: "user" | "assistant";
        content: string;
        providerContent: unknown;
      }> = [];

      return {
        start: vi.fn((msg: string) => {
          messages.push({
            role: "user",
            content: msg,
            providerContent: { role: "user", content: msg },
          });
        }),
        seed: vi.fn(),
        snapshot: vi.fn(() => [...messages]),
        appendToolResults: vi.fn(
          (
            results: Array<{ tool_use_id: string; content: string }>,
            additionalText?: string,
          ) => {
            const text = [
              results.map((r) => r.content).join("\n"),
              additionalText,
            ]
              .filter(Boolean)
              .join("\n");
            messages.push({
              role: "user",
              content: text,
              providerContent: { role: "user", content: results },
            });
          },
        ),
        appendUserMessage: vi.fn((msg: string) => {
          messages.push({
            role: "user",
            content: msg,
            providerContent: { role: "user", content: msg },
          });
        }),
        chat: vi.fn(
          (): Promise<{
            stopReason: "tool_use";
            toolUses: ToolUseItem[];
            text: string;
          }> => {
            const turn = turns[turnIndex++] ??
              turns[turns.length - 1] ?? { toolUses: [], text: "" };
            return new Promise((resolve) => {
              gates.push(() => {
                messages.push({
                  role: "assistant",
                  content: turn.text,
                  providerContent: { role: "assistant", content: turn.text },
                });
                resolve({
                  stopReason: "tool_use",
                  toolUses: turn.toolUses,
                  text: turn.text,
                });
              });
            });
          },
        ),
      };
    };

    return {
      mockCreateProvider: vi.fn(make),
      releaseNext: (): void => {
        gates.shift()?.();
      },
      releaseAll: (): void => {
        const copy = [...gates];
        gates.length = 0;
        for (const g of copy) g();
      },
      setTurns: (t: Turn[]): void => {
        turns = t;
        turnIndex = 0;
        gates.length = 0;
        mockCreateProvider.mockImplementation(make);
      },
    };
  },
);

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import type { NormalizedAlert } from "@nightwatch/shared";
import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { hasPendingInterrupt } from "../db/interrupts.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Investigation complete.",
  toolUses: [],
};

// Platform tool — handled in-process, no runner needed.
const READ_TURN = {
  text: "",
  toolUses: [{ id: "tu-read", name: "get_incident_history", input: {} }],
};

function alert(tokenId: string, sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    token: tokenId,
    targetIdentifier: "web-01",
    alertType: "HighCPU",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
}

describe("mid-run alert injection (loop seam)", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockCreateProvider.mockClear();
  });

  afterEach(async () => {
    releaseAll();
    // Let any remaining microtasks / run finally-blocks settle before cleanup.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("alert injected mid-run appears in the next tool_results user message", async () => {
    const tokenId = mintToken("inject-midrun").id;

    // Turn 1: platform read tool (no runner). Turn 2: free-form finish.
    setTurns([READ_TURN, FINISH_TURN]);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      token: tokenId,
      trigger: "alert",
      alert: alert(tokenId, "primary-mr"),
    });

    // createProvider is called synchronously in start() before the first await.
    const provider = mockCreateProvider.mock.results[0]!.value as {
      appendToolResults: ReturnType<typeof vi.fn>;
    };

    // Inject while parked at turn 1's chat()
    dispatcher.injectAlert(sessionId, alert(tokenId, "injected-mr"));

    // Release turn 1 → loop executes get_incident_history, drains inbox,
    // then calls appendToolResults(results, injectionText)
    releaseNext();

    await waitFor(() => provider.appendToolResults.mock.calls.length > 0);

    const call = provider.appendToolResults.mock.calls[0] as [
      unknown,
      string | undefined,
    ];
    const additionalText = call[1];
    expect(additionalText).toBeDefined();
    expect(additionalText).toContain("injected-mr");

    // Release turn 2 and let the run finish cleanly.
    releaseNext();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });

  it("an alert for a suspended session starts a new session instead of injecting", async () => {
    const tokenId = mintToken("inject-sus").id;

    // Turn 1: gated tool → run suspends. Turn 2: free-form finish for the resume.
    setTurns([
      {
        text: "",
        toolUses: [
          {
            id: "tu-gate",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "test",
              risk: "low",
              estimatedDowntimeSeconds: 1,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      token: tokenId,
      trigger: "alert",
      alert: alert(tokenId, "primary-sus"),
    });

    // Release turn 1 → restart_container is gated → run suspends
    releaseNext();
    await waitFor(() => hasPendingInterrupt(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // After suspension the token has no active session
    expect(dispatcher.getActiveSessionForToken(tokenId)).toBeNull();

    // Dispatching a new alert for the same token creates a new session (not injected)
    const callsBefore = mockCreateProvider.mock.calls.length;
    const newSessionId = randomUUID();

    dispatcher.dispatch({
      sessionId: newSessionId,
      token: tokenId,
      trigger: "alert",
      alert: alert(tokenId, "new-after-sus"),
    });

    await waitFor(() => mockCreateProvider.mock.calls.length > callsBefore);

    // New session is running independently
    expect(dispatcher.isSessionRunning(newSessionId)).toBe(true);
    expect(dispatcher.getActiveSessionForToken(tokenId)).toBe(newSessionId);

    // The suspended session's inbox was not touched
    expect(dispatcher.drainInbox(sessionId)).toHaveLength(0);

    releaseNext(); // free-form finish for the new session
    await waitFor(() => !dispatcher.isSessionRunning(newSessionId));
  });

  it("inbox leftovers when a run ends become new sessions", async () => {
    const tokenId = mintToken("inject-leftover").id;

    // Single turn: free-form finish immediately. The loop exits before any
    // appendToolResults call, so the inbox is never drained by the loop itself.
    setTurns([FINISH_TURN]);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      token: tokenId,
      trigger: "alert",
      alert: alert(tokenId, "primary-lo"),
    });

    // Inject before releasing — alert sits in inbox
    dispatcher.injectAlert(sessionId, alert(tokenId, "leftover-lo"));

    const callsBefore = mockCreateProvider.mock.calls.length;

    // Release: chat() resolves with free-form finish → run exits without draining inbox
    releaseNext();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // The dispatcher's finally block dispatches leftovers as new sessions.
    // createProvider is called synchronously in the new session's start().
    await waitFor(() => mockCreateProvider.mock.calls.length > callsBefore, {
      timeout: 5_000,
    });

    const newProvider = mockCreateProvider.mock.results[
      mockCreateProvider.mock.calls.length - 1
    ]!.value as { start: ReturnType<typeof vi.fn> };
    const openingMsg = newProvider.start.mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(openingMsg).toBeDefined();

    // The leftover session's opening message is for the leftover alert
    releaseNext(); // free-form finish for the leftover session
    await waitFor(() => dispatcher.getActiveSessionForToken(tokenId) === null);
  });
});
