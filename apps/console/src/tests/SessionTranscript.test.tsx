import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { SessionView } from "../pages/SessionTranscript.js";
import { theme, cssVariablesResolver } from "../theme.js";

let latestWs: MockWs | null = null;

class MockWs {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWs.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  close = vi.fn();

  constructor(_url: string) {
    latestWs = this;
  }

  push(envelope: object): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

const SESSION_MESSAGE_1 = {
  sessionId: "s1",
  seq: 1,
  role: "user",
  content: "Service is down on web-01",
  createdAt: "2024-01-01T00:01:00Z",
};

const SESSION_MESSAGE_2 = {
  sessionId: "s1",
  seq: 2,
  role: "assistant",
  content: "I will investigate the service downtime.",
  createdAt: "2024-01-01T00:02:00Z",
};

function setup(messages: object[] = [SESSION_MESSAGE_1]) {
  latestWs = null;

  vi.stubGlobal("WebSocket", MockWs);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/sessions/s1")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(messages),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  // ChatInput uses useNavigate, so a router context is required.
  const root = createRootRoute({
    component: () => <SessionView sessionId="s1" />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionTranscript", () => {
  describe("initial render", () => {
    it("renders all durable messages fetched from the API", async () => {
      setup([SESSION_MESSAGE_1, SESSION_MESSAGE_2]);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
        expect(
          screen.getByText("I will investigate the service downtime."),
        ).toBeInTheDocument();
      });
    });

    it("renders a single message without a blank flash", async () => {
      setup([SESSION_MESSAGE_1]);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });
    });

    it("renders a reloaded session's thinking blocks collapsed, in order", async () => {
      setup([
        SESSION_MESSAGE_1,
        {
          ...SESSION_MESSAGE_2,
          providerContent: [
            { type: "thinking", thinking: "Checked the container logs" },
            { type: "text", text: "Restarting nginx should fix it." },
          ],
        },
      ]);

      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
        expect(
          screen.getByText("Restarting nginx should fix it."),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Checked the container logs")).not.toBeVisible();
    });

    it("renders no thinking dropdown for a reloaded session with no thinking blocks", async () => {
      setup([
        SESSION_MESSAGE_1,
        {
          ...SESSION_MESSAGE_2,
          providerContent: [{ type: "text", text: "All clear." }],
        },
      ]);

      await waitFor(() => {
        expect(screen.getByText("All clear.")).toBeInTheDocument();
      });
      expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    });
  });

  describe("live streaming (TEXT_MESSAGE_CONTENT)", () => {
    it("accumulates delta text into a visible live buffer", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });
    });

    it("concatenates successive delta events into one buffer", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing" },
        });
        latestWs?.push({
          messageId: "m2",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: " the logs..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing the logs...")).toBeInTheDocument();
      });
    });

    it("ignores session_delta for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "other-session",
            kind: "text",
            delta: "Other delta",
          },
        });
      });

      expect(screen.queryByText("Other delta")).not.toBeInTheDocument();
    });
  });

  describe("RUN_FINISHED flush", () => {
    it("clears the live buffer when session_message arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "assistant",
              content: "Investigation complete.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByText("Analyzing...")).not.toBeInTheDocument();
        expect(screen.getByText("Investigation complete.")).toBeInTheDocument();
      });
    });
  });

  describe("tool card (TOOL_CALL_START / TOOL_CALL_END events)", () => {
    it("renders a tool card with IN block when TOOL_CALL_START arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: { service: "nginx" },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.getByText(/nginx/)).toBeInTheDocument();
      });
    });

    it("shows a loading placeholder in OUT block while tool call is in flight", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: { service: "nginx" },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });

      expect(screen.getByTestId("tool-card-out-loading")).toBeInTheDocument();
    });

    it("fills the OUT block when TOOL_CALL_END arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: { service: "nginx" },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m4",
          type: "TOOL_CALL_END",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            result: { status: "stopped", exitCode: 1 },
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByTestId("tool-card-out-loading"),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/stopped/)).toBeInTheDocument();
      });
    });

    it("matches TOOL_CALL_END to the correct card by toolUseId", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: { service: "nginx" },
          },
        });
        latestWs?.push({
          messageId: "m5",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-2",
            toolName: "list_processes",
            input: { filter: "http" },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.getByText("list_processes")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m6",
          type: "TOOL_CALL_END",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-2",
            result: { processes: ["nginx", "node"] },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/nginx.*node|node.*nginx/)).toBeInTheDocument();
        // tu-1 card OUT is still loading
        expect(screen.getByTestId("tool-card-out-loading")).toBeInTheDocument();
      });
    });

    it("ignores TOOL_CALL_START events for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "other-session",
            toolUseId: "tu-99",
            toolName: "should_not_appear",
            input: {},
          },
        });
      });

      expect(screen.queryByText("should_not_appear")).not.toBeInTheDocument();
    });
  });

  describe("thinking choreography (TEXT_MESSAGE_CONTENT kind=thinking)", () => {
    it("renders a pulsing, collapsed-by-default block while thinking deltas stream", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            kind: "thinking",
            delta: "Let me check the logs",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });
      expect(screen.getByText("Let me check the logs")).not.toBeVisible();
    });

    it("expands a streaming thinking block when clicked", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: "Reasoning" },
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /thinking/i }));

      expect(screen.getByText("Reasoning")).toBeVisible();
    });

    it("renders the answer alongside a still-collapsed thinking block", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: "Reasoning" },
        });
      });
      act(() => {
        latestWs?.push({
          messageId: "m4",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "The answer." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("The answer.")).toBeInTheDocument();
      });
      expect(screen.getByText("Reasoning")).not.toBeVisible();
    });

    it("renders multiple thinking bursts as independent, ordered blocks", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: "First burst" },
        });
      });
      act(() => {
        latestWs?.push({
          messageId: "m4",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: {},
          },
        });
      });
      act(() => {
        latestWs?.push({
          messageId: "m5",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            kind: "thinking",
            delta: "Second burst",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("Thinking")).toHaveLength(2);
      });

      const user = userEvent.setup();
      const buttons = screen.getAllByRole("button", { name: /thinking/i });
      await user.click(buttons[0]);
      await user.click(buttons[1]);

      expect(screen.getByText("First burst")).toBeVisible();
      expect(screen.getByText("Second burst")).toBeVisible();
    });

    it("clears thinking blocks once RUN_FINISHED flushes the turn", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: "Reasoning" },
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m4",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 3,
              role: "assistant",
              content: "Done.",
              createdAt: "2024-01-01T00:03:00Z",
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
        expect(screen.getByText("Done.")).toBeInTheDocument();
      });
    });
  });

  describe("approval card (INTERRUPT)", () => {
    function pushGatedStart(): void {
      act(() => {
        latestWs?.push({
          messageId: "a1",
          type: "INTERRUPT",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-gated",
            toolName: "restart_container",
            input: { containerName: "web-01", risk: "high" },
            incidentId: "inc-1",
          },
        });
      });
    }

    it("renders an approval card with tool name, risk, and Approve/Reject buttons before the tool card", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushGatedStart();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const card = screen.getByTestId("approval-card");
      expect(within(card).getByText("restart_container")).toBeInTheDocument();
      expect(within(card).getByText(/high/i)).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /approve/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /reject/i }),
      ).toBeInTheDocument();

      // While pending, only the approval card shows - the execution record (tool
      // card) appears below it only after the decision resolves.
      expect(
        screen.queryByTestId("tool-card-out-loading"),
      ).not.toBeInTheDocument();
    });

    it("posts to /respond with decision=approve and disables both buttons on Approve", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushGatedStart();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("approval-card");
      await user.click(within(card).getByRole("button", { name: /approve/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              decision: "approve",
              resolvedBy: "console",
            }),
          }),
        );
        expect(
          within(card).getByRole("button", { name: /approve/i }),
        ).toBeDisabled();
        expect(
          within(card).getByRole("button", { name: /reject/i }),
        ).toBeDisabled();
      });
    });

    it("replaces the buttons with a resolution label on INTERRUPT_RESOLVED and keeps the tool card below", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushGatedStart();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "a2",
          type: "INTERRUPT_RESOLVED",
          payload: {
            incidentId: "inc-1",
            toolUseId: "tu-gated",
            status: "approved",
            resolvedBy: "operator",
            resolvedAt: "2024-01-01T00:03:00Z",
          },
        });
      });

      await waitFor(() => {
        const card = screen.getByTestId("approval-card");
        expect(
          within(card).getByText(/approved by operator/i),
        ).toBeInTheDocument();
        expect(
          within(card).queryByRole("button", { name: /approve/i }),
        ).not.toBeInTheDocument();
        expect(
          within(card).queryByRole("button", { name: /reject/i }),
        ).not.toBeInTheDocument();
      });

      // The paired tool card now appears below the resolved approval card, OUT
      // still loading until the result (both cards label the tool name).
      expect(screen.getAllByText("restart_container")).toHaveLength(2);
      const resolvedCard = screen.getByTestId("approval-card");
      const toolCardOut = screen.getByTestId("tool-card-out-loading");
      expect(
        resolvedCard.compareDocumentPosition(toolCardOut) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      act(() => {
        latestWs?.push({
          messageId: "a3",
          type: "TOOL_CALL_END",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-gated",
            result: { restarted: true },
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByTestId("tool-card-out-loading"),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/restarted/)).toBeInTheDocument();
      });
    });
  });

  describe("composer integration", () => {
    it("disables the composer while TEXT_MESSAGE_CONTENT events are arriving", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
      });
    });

    it("re-enables the composer once RUN_FINISHED arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "assistant",
              content: "Investigation complete.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).not.toBeDisabled();
        expect(
          screen.getByRole("button", { name: /send/i }),
        ).not.toBeDisabled();
      });
    });
  });

  describe("clarification card (INTERRUPT kind=clarification)", () => {
    function pushClarification(extra: object = {}): void {
      act(() => {
        latestWs?.push({
          messageId: "c1",
          type: "INTERRUPT",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-clar",
            toolName: "request_clarification",
            input: {},
            incidentId: "inc-clar",
            kind: "clarification",
            question: "Which service should I investigate first?",
            options: [
              { label: "nginx", description: "The web server" },
              { label: "postgres", description: "The database" },
            ],
            ...extra,
          },
        });
      });
    }

    it("renders question text and option buttons when clarification interrupt arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const card = screen.getByTestId("clarification-card");
      expect(
        within(card).getByText("Which service should I investigate first?"),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /nginx/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /postgres/i }),
      ).toBeInTheDocument();
    });

    it("clicking an option posts to /respond with text and disables options", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("clarification-card");
      await user.click(within(card).getByRole("button", { name: /nginx/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              text: "nginx",
              resolvedBy: "console",
            }),
          }),
        );
      });
    });

    it("shows Answered label after INTERRUPT_RESOLVED with status=answered", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification();

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "c2",
          type: "INTERRUPT_RESOLVED",
          payload: {
            incidentId: "inc-clar",
            toolUseId: "tu-clar",
            status: "answered",
            resolvedBy: "operator",
          },
        });
      });

      await waitFor(() => {
        const card = screen.getByTestId("clarification-card");
        expect(
          within(card).getByText(/answered by operator/i),
        ).toBeInTheDocument();
        expect(
          within(card).queryByRole("button", { name: /nginx/i }),
        ).not.toBeInTheDocument();
      });
    });

    it("multiSelect: joins selected options and posts to /respond as text", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushClarification({ multiSelect: true });

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("clarification-card");
      await user.click(within(card).getByRole("button", { name: /nginx/i }));
      await user.click(within(card).getByRole("button", { name: /postgres/i }));
      await user.click(within(card).getByRole("button", { name: /submit/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              text: "nginx, postgres",
              resolvedBy: "console",
            }),
          }),
        );
      });
    });

    it("ignores clarification INTERRUPT for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "c-other",
          type: "INTERRUPT",
          payload: {
            sessionId: "other-session",
            toolUseId: "tu-other",
            toolName: "request_clarification",
            input: {},
            incidentId: "inc-other",
            kind: "clarification",
            question: "Should not appear",
            options: [],
          },
        });
      });

      expect(
        screen.queryByTestId("clarification-card"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Should not appear")).not.toBeInTheDocument();
    });
  });

  describe("composer as Other for approval", () => {
    function pushApprovalInterrupt(): void {
      act(() => {
        latestWs?.push({
          messageId: "ap1",
          type: "INTERRUPT",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-ap",
            toolName: "restart_container",
            input: { containerName: "web-01", risk: "high" },
            incidentId: "inc-ap",
            kind: "approval",
          },
        });
      });
    }

    it("posts to /respond with text when user types while approval interrupt is pending", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushApprovalInterrupt();

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "Hold off, monitoring now");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              text: "Hold off, monitoring now",
              resolvedBy: "console",
            }),
          }),
        );
      });

      expect(fetch).not.toHaveBeenCalledWith(
        "/api/sessions/s1/messages",
        expect.anything(),
      );
    });

    it("composer shows Add context placeholder while approval interrupt is pending", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushApprovalInterrupt();

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveAttribute(
          "placeholder",
          "Add context…",
        );
      });
    });

    it("clears the pending interrupt from the composer when INTERRUPT_RESOLVED context_added arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      pushApprovalInterrupt();

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveAttribute(
          "placeholder",
          "Add context…",
        );
      });

      act(() => {
        latestWs?.push({
          messageId: "ctx-res",
          type: "INTERRUPT_RESOLVED",
          payload: {
            incidentId: "inc-ap",
            toolUseId: "tu-ap",
            status: "context_added",
            resolvedBy: "console",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveAttribute(
          "placeholder",
          "Type a message…",
        );
      });
    });
  });

  describe("composer as Other for clarification", () => {
    it("posts to /respond with text when user types while clarification interrupt is pending", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "clar1",
          type: "INTERRUPT",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-clar2",
            toolName: "request_clarification",
            input: {},
            incidentId: "inc-clar2",
            kind: "clarification",
            question: "Any other context?",
            options: [{ label: "No", description: "Nothing else" }],
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "Check memory too");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              text: "Check memory too",
              resolvedBy: "console",
            }),
          }),
        );
      });

      expect(fetch).not.toHaveBeenCalledWith(
        "/api/sessions/s1/messages",
        expect.anything(),
      );
    });
  });

  describe("role-based rendering", () => {
    it("renders a persisted user message as a right-aligned bubble", async () => {
      setup([SESSION_MESSAGE_1]);

      await waitFor(() => {
        expect(screen.getByTestId("user-bubble")).toBeInTheDocument();
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });
    });

    it("renders a persisted assistant message as markdown (paragraph element)", async () => {
      setup([SESSION_MESSAGE_2]);

      await waitFor(() => {
        expect(
          screen.getByText("I will investigate the service downtime."),
        ).toBeInTheDocument();
        // react-markdown wraps plain text in a <p>
        const p = document.querySelector("p");
        expect(p).toBeInTheDocument();
      });
    });

    it("live stream and persisted path render the same text after RUN_FINISHED", async () => {
      setup([SESSION_MESSAGE_1]);

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "All clear." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("All clear.")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "assistant",
              content: "All clear.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      // After flush, the persisted converter takes over — same text still visible.
      await waitFor(() => {
        expect(screen.getByText("All clear.")).toBeInTheDocument();
      });
    });

    it("renders the centered transcript column", async () => {
      setup([SESSION_MESSAGE_1]);

      await waitFor(() => {
        expect(screen.getByTestId("transcript-column")).toBeInTheDocument();
      });
    });
  });
});
