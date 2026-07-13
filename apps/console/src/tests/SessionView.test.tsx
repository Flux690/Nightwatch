import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { SessionView } from "../pages/SessionView.js";
import { ConsoleEventsProvider } from "@/hooks/ConsoleEventsProvider";
import { MockEventSource } from "./mockEventSource.js";

vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({
    phase: { kind: "authenticated", email: "operator@nightwatch.io" },
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  }),
}));

const SESSION_MESSAGE_1 = {
  sessionId: "s1",
  seq: 1,
  role: "user",
  content: "Service is down on web-01",
  createdAt: "2024-01-01T00:01:00Z",
};

function setup(
  messages: object[] = [SESSION_MESSAGE_1],
  pendingHumanInput: object[] = [],
) {
  MockEventSource.reset();

  vi.stubGlobal("EventSource", MockEventSource);
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("pending-human-input")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(pendingHumanInput),
      });
    }
    if (url.includes("/sessions/s1")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(messages),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

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
    <TestProviders>
      <QueryClientProvider client={qc}>
        <ConsoleEventsProvider>
          <RouterProvider router={router} />
        </ConsoleEventsProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { qc, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionView", () => {
  describe("live streaming (TEXT_MESSAGE_CONTENT)", () => {
    it("accumulates delta text into a visible live buffer", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing" },
        });
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
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

    it("fills the OUT block when TOOL_CALL_END arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TOOL_CALL_START",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            input: { service: "nginx" },
          },
        });
        MockEventSource.latest?.push({
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
        MockEventSource.latest?.push({
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
        // The list_processes output landed (clamped to 3 lines, so assert on
        // the quoted first entry rather than the whole array).
        expect(screen.getByText(/"nginx"/)).toBeInTheDocument();
        // tu-1 is still running: its card has no output area at all yet.
        const pending = screen
          .getAllByTestId("tool-card")
          .find((card) => card.textContent?.includes("check_service_status"));
        expect(pending).toBeDefined();
        expect(pending!.querySelector("pre")).toBeNull();
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
        MockEventSource.latest?.push({
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
    it("clears thinking blocks once RUN_FINISHED flushes the turn", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: "Reasoning" },
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
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

  describe("thinking pulse (immediate affordance)", () => {
    it("shows the pulse on send and keeps it through the user-turn persist", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // The pulse and the echoed bubble show the instant the message is sent.
      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });
      expect(screen.getAllByText("check the db")).toHaveLength(1);

      // Persisting the user's own turn must NOT wipe the pulse.
      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "user",
              content: "check the db",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("check the db")).toHaveLength(1);
      });
      expect(screen.getByText("Thinking")).toBeInTheDocument();

      // The first assistant token takes over from the pulse.
      act(() => {
        MockEventSource.latest?.push({
          messageId: "a1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            kind: "text",
            delta: "Checking the database...",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText("Checking the database..."),
        ).toBeInTheDocument();
      });
    });

    it("merges the first thinking delta into the seeded pulse element", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByTestId("thinking-block")).toBeInTheDocument();
      });
      const pulseNode = screen.getByTestId("thinking-block");

      act(() => {
        MockEventSource.latest?.push({
          messageId: "t1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "s1",
            kind: "thinking",
            delta: "Looking at the",
          },
        });
        MockEventSource.latest?.push({
          messageId: "t2",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "thinking", delta: " db metrics" },
        });
      });

      // Exactly one thinking block, and it is the same DOM node the pulse
      // rendered - the takeover is a content change, never a remount.
      await waitFor(() => {
        expect(screen.getByText("Looking at the db metrics")).toBeVisible();
      });
      const blocks = screen.getAllByTestId("thinking-block");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toBe(pulseNode);
    });

    it("drops the empty pulse when the run goes straight to a tool call", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "restart nginx");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(screen.getByText("Thinking")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
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

      // No ghost "Thinking" line survives a burst that never got text.
      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
      });
    });
  });

  describe("optimistic echo", () => {
    it("echoes the message instantly and keeps exactly one bubble through the persist", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // The bubble is there before any server event, and the box is cleared.
      expect(screen.getAllByText("check the db")).toHaveLength(1);
      expect(screen.getByRole("textbox")).toHaveValue("");

      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "user",
              content: "check the db",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      // The persisted row replaces the echo one-for-one, never both.
      await waitFor(() => {
        expect(screen.getAllByText("check the db")).toHaveLength(1);
      });
    });

    it("rolls back the echo and restores the text when the send never reaches the API", async () => {
      const { fetchMock } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).includes("/messages") && init?.method === "POST") {
          return Promise.reject(new Error("network down"));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // Echo and pulse roll back; the composer gets the message back. The
      // only remaining bubble is the session's original persisted turn.
      await waitFor(() => {
        expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
        expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
        expect(screen.getByRole("textbox")).toHaveValue("check the db");
        expect(screen.getByRole("textbox")).not.toBeDisabled();
      });
    });
  });

  describe("approval card (INTERRUPT)", () => {
    function pushGatedStart(): void {
      act(() => {
        MockEventSource.latest?.push({
          messageId: "a1",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-gated",
            toolName: "RestartService",
            input: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
              risk: "high",
            },
            incidentId: "inc-1",
          },
        });
      });
    }

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
        MockEventSource.latest?.push({
          messageId: "a2",
          type: "HUMAN_INPUT_RESOLVED",
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

      // The paired tool card now appears below the resolved approval card,
      // header-only until the result arrives (both cards label the tool name).
      expect(screen.getAllByText("RestartService")).toHaveLength(2);
      const resolvedCard = screen.getByTestId("approval-card");
      const toolCard = screen.getByTestId("tool-card");
      expect(
        resolvedCard.compareDocumentPosition(toolCard) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(toolCard.querySelector("pre")).toBeNull();

      act(() => {
        MockEventSource.latest?.push({
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
        expect(screen.getByText(/restarted/)).toBeInTheDocument();
      });
    });
  });

  describe("reload reconstruction (pending interrupt on load)", () => {
    it("shows an approval card on load for a session with a durable pending approval, with no live event", async () => {
      setup(
        [SESSION_MESSAGE_1],
        [
          {
            sessionId: "s1",
            toolUseId: "tu-durable",
            toolName: "RestartService",
            toolInput: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
              risk: "high",
            },
            kind: "approval",
            status: "pending",
            createdAt: "2024-01-01T00:05:00Z",
          },
        ],
      );

      await waitFor(() => {
        const card = screen.getByTestId("approval-card");
        expect(within(card).getByText("RestartService")).toBeInTheDocument();
        expect(within(card).getByText(/high/i)).toBeInTheDocument();
        expect(
          within(card).getByRole("button", { name: /approve/i }),
        ).toBeInTheDocument();
      });
    });

    it("shows a clarification card on load for a session with a durable pending clarification", async () => {
      setup(
        [SESSION_MESSAGE_1],
        [
          {
            sessionId: "s1",
            toolUseId: "tu-durable-clar",
            toolName: "AskUserQuestion",
            toolInput: {
              question: "Which service first?",
              options: [{ label: "nginx", description: "The web server" }],
            },
            kind: "clarification",
            status: "pending",
            createdAt: "2024-01-01T00:05:00Z",
          },
        ],
      );

      await waitFor(() => {
        const card = screen.getByTestId("clarification-card");
        expect(
          within(card).getByText("Which service first?"),
        ).toBeInTheDocument();
        expect(
          within(card).getByRole("radio", { name: /^nginx$/i }),
        ).toBeInTheDocument();
      });
    });

    it("approving a reconstructed card posts to /respond exactly like a live one", async () => {
      setup(
        [SESSION_MESSAGE_1],
        [
          {
            sessionId: "s1",
            toolUseId: "tu-durable",
            toolName: "RestartService",
            toolInput: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
              risk: "high",
            },
            kind: "approval",
            status: "pending",
            createdAt: "2024-01-01T00:05:00Z",
          },
        ],
      );

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
      });
    });

    it("ignores a pending interrupt belonging to a different session", async () => {
      setup(
        [SESSION_MESSAGE_1],
        [
          {
            sessionId: "other-session",
            toolUseId: "tu-other",
            toolName: "RestartService",
            toolInput: { risk: "high" },
            kind: "approval",
            status: "pending",
            createdAt: "2024-01-01T00:05:00Z",
          },
        ],
      );

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
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
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(
          screen.getByRole("button", { name: /stop/i }),
        ).toBeInTheDocument();
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
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      act(() => {
        MockEventSource.latest?.push({
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
        ).toBeInTheDocument();
      });
    });

    it("shows sandbox provisioning stages and clears the line when ready", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "sb-1",
          type: "SANDBOX_STATUS",
          payload: { sessionId: "s1", stage: "cloning" },
        });
      });
      await waitFor(() => {
        expect(
          screen.getByText(/Preparing sandbox - cloning the repository/),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "sb-2",
          type: "SANDBOX_STATUS",
          payload: { sessionId: "s1", stage: "starting" },
        });
      });
      await waitFor(() => {
        expect(
          screen.getByText(/Preparing sandbox - starting the container/),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "sb-3",
          type: "SANDBOX_STATUS",
          payload: { sessionId: "s1", stage: "installing" },
        });
      });
      await waitFor(() => {
        expect(
          screen.getByText(/Preparing sandbox - installing dependencies/),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "sb-4",
          type: "SANDBOX_STATUS",
          payload: { sessionId: "s1", stage: "ready" },
        });
      });
      await waitFor(() => {
        expect(screen.queryByText(/Preparing sandbox/)).not.toBeInTheDocument();
      });
    });

    it("shows the retry status line on RUN_RETRYING and clears it when streaming resumes", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m-retry",
          type: "RUN_RETRYING",
          payload: {
            sessionId: "s1",
            attempt: 2,
            maxAttempts: 4,
            delaySeconds: 15,
            summary: "Provider error (502). Retrying in 15s - attempt 2 of 4.",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            "Provider error (502). Retrying in 15s - attempt 2 of 4.",
          ),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m-resume",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Back online." },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByText(
            "Provider error (502). Retrying in 15s - attempt 2 of 4.",
          ),
        ).not.toBeInTheDocument();
      });
    });

    it("re-enables the composer when RUN_FAILED arrives (run not left spinning)", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m-fail",
          type: "RUN_FAILED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              role: "error",
              content:
                "The model provider had a server problem - this is upstream, not your setup.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      // The failure reads like any other message in the conversation and the
      // composer is usable again.
      await waitFor(() => {
        expect(
          screen.getByText(/The model provider had a server problem/),
        ).toBeInTheDocument();
        expect(screen.getByRole("textbox")).not.toBeDisabled();
        expect(
          screen.getByRole("button", { name: /send/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("clarification card (INTERRUPT kind=clarification)", () => {
    function pushClarification(extra: object = {}): void {
      act(() => {
        MockEventSource.latest?.push({
          messageId: "c1",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-clar",
            toolName: "AskUserQuestion",
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
        within(card).getByRole("radio", { name: /^nginx$/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("radio", { name: /^postgres$/i }),
      ).toBeInTheDocument();
    });

    it("selecting an option and submitting posts to /respond with text and disables options", async () => {
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
      await user.click(within(card).getByRole("radio", { name: /^nginx$/i }));
      await user.click(within(card).getByRole("button", { name: /submit/i }));

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
        MockEventSource.latest?.push({
          messageId: "c2",
          type: "HUMAN_INPUT_RESOLVED",
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
          within(card).queryByRole("radio", { name: /^nginx$/i }),
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
      await user.click(
        within(card).getByRole("checkbox", { name: /^nginx$/i }),
      );
      await user.click(
        within(card).getByRole("checkbox", { name: /^postgres$/i }),
      );
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

    it("keeps an answered card visible when a new message is sent before the run flushes it", async () => {
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
      await user.click(within(card).getByRole("radio", { name: /^nginx$/i }));
      await user.click(within(card).getByRole("button", { name: /submit/i }));

      // The answered card is still live-only; sending must not wipe it.
      await user.type(screen.getByRole("textbox"), "also check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(screen.getByTestId("clarification-card")).toBeInTheDocument();
      expect(screen.getByText("Thinking")).toBeInTheDocument();
    });

    it("ignores clarification INTERRUPT for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "c-other",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "other-session",
            toolUseId: "tu-other",
            toolName: "AskUserQuestion",
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

  describe("stream reconnect", () => {
    it("refetches active queries after the event stream reconnects", async () => {
      const { fetchMock } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const transcriptFetches = (): number =>
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/sessions/s1"),
        ).length;
      const before = transcriptFetches();

      // A drop then reopen: events published during the gap are lost (the feed
      // has no replay), so the provider must invalidate queries to catch up.
      act(() => {
        const es = MockEventSource.latest;
        if (es) es.readyState = MockEventSource.CONNECTING;
        MockEventSource.latest?.onerror?.();
        MockEventSource.latest?.onopen?.();
      });

      await waitFor(() => {
        expect(transcriptFetches()).toBeGreaterThan(before);
      });
    });
  });
});
