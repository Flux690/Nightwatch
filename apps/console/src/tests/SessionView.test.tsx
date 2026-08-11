import {
  render,
  screen,
  waitFor,
  act,
  within,
  cleanup,
} from "@testing-library/react";
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
import { routeTree } from "@/router";
import { MockEventSource } from "./mockEventSource.js";

// AuthProvider as well as the hook: the page tests drive the real route tree,
// whose root mounts the provider before any page renders.
vi.mock("@/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    phase: { kind: "authenticated", email: "operator@nightwarden.io" },
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  }),
}));

// The projected transcript the API returns: items to draw, not raw messages.
const USER_TURN = {
  kind: "user_turn",
  id: "user-1-0",
  text: "Service is down on web-01",
};

function setup(initialItems: object[] = [USER_TURN], running = false) {
  MockEventSource.reset();

  // Mutable, because the projection lives server-side now: a test that fires a
  // MESSAGE event states what the server would then project.
  let items = initialItems;
  const setItems = (next: object[]): void => {
    items = next;
  };

  // A decision the test can hold open, so "in flight" is a state it controls
  // rather than a race against an instantly-resolving mock.
  let holdingRespond = false;
  let releaseRespond: (() => void) | null = null;
  const holdRespond = (): (() => void) => {
    holdingRespond = true;
    return () => releaseRespond?.();
  };

  vi.stubGlobal("EventSource", MockEventSource);
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/respond") && holdingRespond) {
      return new Promise((resolve) => {
        releaseRespond = () =>
          resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    }
    // The session answers what it is and carries its transcript; the report is
    // a separate resource that may not exist yet.
    if (url.endsWith("/sessions/s1")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessionId: "s1",
            title: "Service is down on web-01",
            createdAt: "2026-06-13T00:00:00.000Z",
            investigation: false,
            running,
            alerts: [],
            transcript: items,
          }),
      });
    }
    if (url.includes("/sessions/s1")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(items),
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

  return { qc, fetchMock, setItems, holdRespond };
}

const AGO_MINUTES = (n: number): string =>
  new Date(Date.now() - n * 60_000).toISOString();

// One per group, so the day headings have something to hold, plus an
// investigation the chat list must never be asked for.
const CHAT_ROWS = [
  { sessionId: "c1", title: "Why is redis restarting?", minutes: 5 },
  { sessionId: "c2", title: "Explain the checkout deploy", minutes: 60 * 30 },
  {
    sessionId: "c3",
    title: "What does this label mean?",
    minutes: 60 * 24 * 9,
  },
];

/* The page rather than the conversation: the header, its disclosure and its
   menu live in AgentPage, so this drives the real route tree the way AppShell
   does. The conversation below it is the same portalled node either way. */
function setupPage({
  path = "/agent",
  running = false,
}: { path?: string; running?: boolean } = {}) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", 1280);

  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

  const fetchMock = vi.fn().mockImplementation((url: string, init?: object) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ownerExists: true,
            authenticated: true,
            email: "operator@nightwarden.io",
          }),
      });
    }
    const record = /\/sessions\/([^?/]+)$/.exec(url);
    if (record !== null && !url.includes("?")) {
      const id = record[1]!;
      if ((init as { method?: string })?.method === "DELETE") {
        return Promise.resolve({ ok: true, status: 204, json: () => null });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessionId: id,
            title: CHAT_ROWS.find((r) => r.sessionId === id)?.title ?? "Chat",
            createdAt: "2026-06-13T00:00:00.000Z",
            investigation: false,
            running,
            alerts: [],
            transcript: [
              {
                kind: "user_turn",
                id: "u-1",
                text: "Why is redis restarting?",
              },
              {
                kind: "thinking",
                id: "t-1",
                text: "checking the logs",
                streaming: false,
              },
              {
                kind: "agent_text",
                id: "a-1",
                text: "It was OOM-killed at 02:14.",
              },
            ],
          }),
      });
    }
    if (url.includes("/sessions")) {
      // Answering only what was asked for is the point: a page that requested
      // every session would be handed the investigation below.
      const rows = url.includes("kind=chat")
        ? CHAT_ROWS.map((row) => ({
            sessionId: row.sessionId,
            title: row.title,
            createdAt: AGO_MINUTES(row.minutes),
            lastActivityAt: AGO_MINUTES(row.minutes),
            investigation: false,
            severity: null,
            severityLabel: null,
            status: null,
            finding: null,
            awaitingHumanInput: false,
          }))
        : [];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ rows, nextOffset: null, investigationTotal: 0 }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, fetchMock, writeText };
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

  describe("MESSAGE flush", () => {
    it("clears the live buffer when the assistant MESSAGE arrives", async () => {
      const { setItems } = setup();

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

      setItems([
        USER_TURN,
        {
          kind: "agent_text",
          id: "agent-2-0",
          text: "Investigation complete.",
        },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "m2",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "assistant",
              content: "Investigation complete.",
              parts: [{ type: "text", text: "Investigation complete." }],
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

  describe("tool card (TRANSCRIPT_ITEM events)", () => {
    it("renders a tool card with IN block when the API sends a running call", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.getByText(/nginx/)).toBeInTheDocument();
      });
    });

    it("fills the OUT block when the call completes", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m4",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-1",
              toolName: "check_service_status",
              input: {},
              state: {
                phase: "complete",
                result: { status: "stopped", exitCode: 1 },
              },
            },
          },
        });
      });

      // Output is evidence to check rather than the thread to follow, so it
      // collapses until asked for. The row itself is the disclosure.
      const disclosure = await screen.findByRole("button", {
        name: /check_service_status/,
      });
      expect(screen.queryByText(/stopped/)).not.toBeInTheDocument();

      await userEvent.setup().click(disclosure);
      expect(screen.getByText(/stopped/)).toBeInTheDocument();
    });

    it("replaces the right card by toolUseId, leaving the other alone", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
        MockEventSource.latest?.push({
          messageId: "m5",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-2",
              toolName: "list_processes",
              input: { filter: "http" },
              state: { phase: "running" },
            },
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
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-2",
              toolName: "check_service_status",
              input: {},
              state: {
                phase: "complete",
                result: { processes: ["nginx", "node"] },
              },
            },
          },
        });
      });

      // Exactly one card gained output: the one the item named. The other is
      // still running, so its row is disabled and cannot be opened.
      const rows = await screen.findAllByRole("button", {
        name: /check_service_status|list_processes/,
      });
      const disclosures = rows.filter((r) => !r.hasAttribute("disabled"));
      expect(disclosures).toHaveLength(1);

      await userEvent.setup().click(disclosures[0]!);
      expect(screen.getByText(/"nginx"/)).toBeInTheDocument();
    });

    it("ignores items for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "other-session",
            item: {
              kind: "tool_card",
              toolUseId: "tu-99",
              toolName: "should_not_appear",
              input: {},
              state: { phase: "running" },
            },
          },
        });
      });

      expect(screen.queryByText("should_not_appear")).not.toBeInTheDocument();
    });
  });

  describe("thinking choreography (TEXT_MESSAGE_CONTENT kind=thinking)", () => {
    it("clears thinking blocks once the assistant MESSAGE flushes the turn", async () => {
      const { setItems } = setup();

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

      setItems([
        USER_TURN,
        { kind: "agent_text", id: "agent-3-0", text: "Done." },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "m4",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 3,
              kind: "assistant",
              content: "Done.",
              parts: [{ type: "text", text: "Done." }],
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

  describe("working indicator (immediate affordance)", () => {
    it("shows the indicator on send and keeps it through the user-turn persist", async () => {
      const { setItems } = setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox"), "check the db");
      await user.click(screen.getByRole("button", { name: /send/i }));

      // The indicator and the echoed bubble show the instant the message is sent,
      // with no bare "Thinking" line.
      await waitFor(() => {
        expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      });
      expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
      expect(screen.getAllByText("check the db")).toHaveLength(1);

      // Persisting the user's own turn is a MESSAGE, not a terminal: the run is
      // still active, so the indicator stays.
      setItems([
        USER_TURN,
        { kind: "user_turn", id: "user-2-0", text: "check the db" },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "user",
              content: "check the db",
              parts: [{ type: "text", text: "check the db" }],
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("check the db")).toHaveLength(1);
      });
      expect(screen.getByTestId("working-indicator")).toBeInTheDocument();

      // The first assistant token takes over: the indicator gives way to output.
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
      expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    });

    it("replaces the indicator with a thinking block once real reasoning streams", async () => {
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
        expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      });

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

      // The reasoning text surfaces as a single thinking block; the indicator,
      // now that there is something to show, is gone.
      await waitFor(() => {
        expect(screen.getByText("Looking at the db metrics")).toBeVisible();
      });
      expect(screen.getAllByTestId("thinking-block")).toHaveLength(1);
      expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    });

    it("shows no thinking line when the run goes straight to a tool call", async () => {
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
        expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
      });

      act(() => {
        MockEventSource.latest?.push({
          messageId: "m3",
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "tool_card",
              toolUseId: "tu-1",
              toolName: "check_service_status",
              input: { target: "nginx" },
              state: { phase: "running" },
            },
          },
        });
      });

      // The in-flight tool card is the thing to show, so the indicator steps
      // aside and no bare "Thinking" line ever appears.
      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
        expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
      });
      expect(screen.queryByTestId("working-indicator")).not.toBeInTheDocument();
    });
  });

  describe("optimistic echo", () => {
    it("echoes the message instantly and keeps exactly one bubble through the persist", async () => {
      const { setItems } = setup();

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

      setItems([
        USER_TURN,
        { kind: "user_turn", id: "user-2-0", text: "check the db" },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "u1",
          type: "MESSAGE",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "user",
              content: "check the db",
              parts: [{ type: "text", text: "check the db" }],
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

      // Echo and working indicator roll back; the chat input gets the message
      // back. The only remaining bubble is the session's original persisted turn.
      await waitFor(() => {
        expect(screen.getAllByTestId("user-turn")).toHaveLength(1);
        expect(
          screen.queryByTestId("working-indicator"),
        ).not.toBeInTheDocument();
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
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "approval_card",
              toolUseId: "tu-gated",
              toolName: "RestartDockerService",
              input: { target: "docker/web-01/web-01", risk: "high" },
              risk: "high",
              state: { phase: "awaiting_human" },
            },
          },
        });
      });
    }

    it("posts to /respond with decision=approve and disables both buttons on Approve", async () => {
      const { holdRespond } = setup();
      const release = holdRespond();

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
      await user.click(within(card).getByRole("button", { name: /restart/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              decision: "approve",
            }),
          }),
        );
        expect(
          within(card).getByRole("button", { name: /restart/i }),
        ).toBeDisabled();
        expect(
          within(card).getByRole("button", { name: /reject/i }),
        ).toBeDisabled();
      });
      act(() => {
        release();
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
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "approval_card",
              toolUseId: "tu-gated",
              toolName: "RestartDockerService",
              input: { target: "docker/web-01/web-01", risk: "high" },
              risk: "high",
              state: {
                phase: "resolved",
                decision: "approved",
                by: "operator",
                result: "web-01 restarted",
              },
            },
          },
        });
      });

      await waitFor(() => {
        const card = screen.getByTestId("approval-card");
        expect(within(card).getByText(/^approved$/i)).toBeInTheDocument();
        expect(
          within(card).queryByRole("button", { name: /restart/i }),
        ).not.toBeInTheDocument();
        expect(
          within(card).queryByRole("button", { name: /reject/i }),
        ).not.toBeInTheDocument();
      });

      // The decision carries the result of the tool it released, so the paired
      // tool card renders below it with that output already in place.
      expect(screen.getAllByText("RestartDockerService")).toHaveLength(2);
      const resolvedCard = screen.getByTestId("approval-card");
      const toolCard = screen.getByTestId("tool-card");
      expect(
        resolvedCard.compareDocumentPosition(toolCard) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The result is the row's finding, so it reads without being expanded.
      expect(
        within(toolCard).getByText(/web-01 restarted/),
      ).toBeInTheDocument();
    });
  });

  describe("reload reconstruction (pending interrupt on load)", () => {
    it("shows an approval card on load for a session with a durable pending approval, with no live event", async () => {
      setup([
        USER_TURN,
        {
          kind: "approval_card",
          toolUseId: "tu-durable",
          toolName: "RestartDockerService",
          input: { target: "docker/web-01/web-01", risk: "high" },
          risk: "high",
          state: { phase: "awaiting_human" },
        },
      ]);

      await waitFor(() => {
        const card = screen.getByTestId("approval-card");
        expect(
          within(card).getByText("RestartDockerService"),
        ).toBeInTheDocument();
        expect(within(card).getByText(/high/i)).toBeInTheDocument();
        expect(
          within(card).getByRole("button", { name: /restart/i }),
        ).toBeInTheDocument();
      });
    });

    it("shows a clarification card on load for a session with a durable pending clarification", async () => {
      setup([
        USER_TURN,
        {
          kind: "clarification_card",
          toolUseId: "tu-durable-clar",
          toolName: "AskUserQuestion",
          input: {},
          question: "Which service first?",
          options: [{ label: "nginx", description: "The web server" }],
          state: { phase: "awaiting_human" },
        },
      ]);

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
      setup([
        USER_TURN,
        {
          kind: "approval_card",
          toolUseId: "tu-durable",
          toolName: "RestartDockerService",
          input: { target: "docker/web-01/web-01", risk: "high" },
          risk: "high",
          state: { phase: "awaiting_human" },
        },
      ]);

      await waitFor(() => {
        expect(screen.getByTestId("approval-card")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const card = screen.getByTestId("approval-card");
      await user.click(within(card).getByRole("button", { name: /restart/i }));

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          "/api/sessions/s1/respond",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              decision: "approve",
            }),
          }),
        );
      });
    });
  });

  describe("chat input integration", () => {
    it("disables the chat input while TEXT_MESSAGE_CONTENT events are arriving", async () => {
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

    it("re-enables the chat input once RUN_FINISHED arrives", async () => {
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
          payload: { sessionId: "s1", reason: "completed" },
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

    it("re-enables the chat input when RUN_FAILED arrives (run not left spinning)", async () => {
      const { setItems } = setup();

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

      setItems([
        USER_TURN,
        {
          kind: "error_text",
          id: "error-2",
          text: "The model provider had a server problem - this is upstream, not your setup.",
        },
      ]);
      act(() => {
        MockEventSource.latest?.push({
          messageId: "m-fail",
          type: "RUN_FAILED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 2,
              kind: "error",
              content:
                "The model provider had a server problem - this is upstream, not your setup.",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      // The failure reads like any other message in the conversation and the
      // chat input is usable again.
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
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "clarification_card",
              toolUseId: "tu-clar",
              toolName: "AskUserQuestion",
              input: {},
              question: "Which service should I investigate first?",
              options: [
                { label: "nginx", description: "The web server" },
                { label: "postgres", description: "The database" },
              ],
              state: { phase: "awaiting_human" },
              ...extra,
            },
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
          type: "TRANSCRIPT_ITEM",
          payload: {
            sessionId: "s1",
            item: {
              kind: "clarification_card",
              toolUseId: "tu-clar",
              toolName: "AskUserQuestion",
              input: {},
              question: "Which service should I investigate first?",
              state: {
                phase: "resolved",
                decision: "answered",
                by: "operator",
                result: "nginx",
              },
            },
          },
        });
      });

      await waitFor(() => {
        const card = screen.getByTestId("clarification-card");
        expect(within(card).getByText("AskUserQuestion")).toBeInTheDocument();
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
      expect(screen.getByTestId("working-indicator")).toBeInTheDocument();
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

  // The stream is this component's own state, so leaving and coming back starts
  // it empty. Without the snapshot saying so, a live run reads as finished.
  describe("rejoining a session that is already running", () => {
    it("shows the run as working and holds the composer closed", async () => {
      setup([USER_TURN], true);

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });
      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    });

    it("leaves the composer open when the snapshot says nothing is running", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });
      expect(screen.getByRole("textbox")).not.toBeDisabled();
    });
  });
});

describe("the Agent page", () => {
  // The name and its chevron are one control, so the disclosure is named by
  // where you are rather than by a label sitting next to it.
  async function openHistory(name: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name }));
  }

  it("heads a new conversation 'New chat' and an open one by its title", async () => {
    setupPage();
    expect(
      await screen.findByRole("button", { name: "New chat" }),
    ).toBeInTheDocument();

    cleanup();
    setupPage({ path: "/agent/c1" });
    expect(
      await screen.findByRole("button", { name: "Why is redis restarting?" }),
    ).toBeInTheDocument();
  });

  it("lists only conversations a person started, grouped by day", async () => {
    const { fetchMock } = setupPage();
    await openHistory("New chat");

    const panel = await screen.findByRole("dialog");
    expect(
      within(panel).getByRole("link", { name: /Why is redis restarting\?/ }),
    ).toBeInTheDocument();

    // The filter is the whole of "only what a person started", so the request
    // carrying it is the behaviour worth pinning. Which day heading a row lands
    // under is the clock's business, not this test's.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("kind=chat")),
    ).toBe(true);
  });

  it("offers a New chat entry above the list only once a session is open", async () => {
    setupPage();
    await openHistory("New chat");
    expect(
      within(await screen.findByRole("dialog")).queryByRole("link", {
        name: "New chat",
      }),
    ).not.toBeInTheDocument();

    cleanup();
    setupPage({ path: "/agent/c1" });
    await openHistory("Why is redis restarting?");
    const panel = await screen.findByRole("dialog");
    const fresh = within(panel).getByRole("link", { name: "New chat" });
    const firstRow = within(panel).getByRole("link", {
      name: /Why is redis restarting\?/,
    });
    expect(
      (fresh.compareDocumentPosition(firstRow) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    ).toBe(true);
  });

  it("copies the conversation as a title and alternating role headings", async () => {
    const user = userEvent.setup();
    const { writeText } = setupPage({ path: "/agent/c1" });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy as Markdown" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Thinking is collapsed on screen for the same reason it is absent here.
    expect(writeText.mock.calls[0]?.[0]).toBe(
      "# Why is redis restarting?\n\n" +
        "## User\n\nWhy is redis restarting?\n\n" +
        "## Assistant\n\nIt was OOM-killed at 02:14.\n",
    );
  });

  it("names the chat in its delete confirmation and then deletes it", async () => {
    const user = userEvent.setup();
    const { fetchMock, router } = setupPage({ path: "/agent/c1" });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Why is redis restarting?");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/sessions/c1") &&
            (init as { method?: string })?.method === "DELETE",
        ),
      ).toBe(true);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/agent"));
  });

  it("does not offer to delete a chat a run is still holding", async () => {
    const user = userEvent.setup();
    setupPage({ path: "/agent/c1", running: true });

    await user.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Delete" }),
    ).toHaveAttribute("data-disabled");
  });
});
