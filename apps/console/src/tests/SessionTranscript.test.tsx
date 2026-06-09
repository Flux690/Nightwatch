import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { SessionTranscript } from "../pages/SessionTranscript.js";
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

const INSTALLATION = {
  id: "inst-1",
  token: "tok-1",
  hostname: "host-1",
  online: true,
  createdAt: "2024-01-01T00:00:00Z",
};

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
      if (url.includes("/installations")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([INSTALLATION]),
        });
      }
      if (url.includes("/sessions/s1")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(messages),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const root = createRootRoute({ component: Outlet });
  const sessionIdRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$id",
    component: SessionTranscript,
  });
  const router = createRouter({
    routeTree: root.addChildren([sessionIdRoute]),
    history: createMemoryHistory({ initialEntries: ["/sessions/s1"] }),
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
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
  });

  describe("live streaming (session_delta)", () => {
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
          type: "session_delta",
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
          type: "session_delta",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing" },
        });
        latestWs?.push({
          messageId: "m2",
          type: "session_delta",
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
          type: "session_delta",
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

  describe("session_message flush", () => {
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
          type: "session_delta",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing...")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "session_message",
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

  describe("tool card (tool_call events)", () => {
    it("renders a tool card with IN block when tool_call phase=start arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            phase: "start",
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
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            phase: "start",
            input: { service: "nginx" },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("check_service_status")).toBeInTheDocument();
      });

      expect(screen.getByTestId("tool-card-out-loading")).toBeInTheDocument();
    });

    it("fills the OUT block when tool_call phase=result arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            phase: "start",
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
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            phase: "result",
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

    it("matches phase=result to the correct card by toolUseId", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-1",
            toolName: "check_service_status",
            phase: "start",
            input: { service: "nginx" },
          },
        });
        latestWs?.push({
          messageId: "m5",
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-2",
            toolName: "list_processes",
            phase: "start",
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
          type: "tool_call",
          payload: {
            sessionId: "s1",
            toolUseId: "tu-2",
            toolName: "list_processes",
            phase: "result",
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

    it("ignores tool_call events for a different session", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "tool_call",
          payload: {
            sessionId: "other-session",
            toolUseId: "tu-99",
            toolName: "should_not_appear",
            phase: "start",
            input: {},
          },
        });
      });

      expect(screen.queryByText("should_not_appear")).not.toBeInTheDocument();
    });
  });

  describe("composer integration", () => {
    it("disables the composer while session_delta events are arriving", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "session_delta",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
      });
    });

    it("re-enables the composer once session_message arrives", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByText("Service is down on web-01"),
        ).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "session_delta",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeDisabled();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "session_message",
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
});
