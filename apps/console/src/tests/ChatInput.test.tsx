import { render, screen } from "@testing-library/react";
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
import userEvent from "@testing-library/user-event";

import { ChatInput } from "../pages/ChatInput.js";
import { theme, cssVariablesResolver } from "../theme.js";

function setup(
  props: {
    sessionId: string | null;
    isRunning: boolean;
    pendingInterrupt?: { id: string; kind: "approval" | "clarification" };
  },
  routePath = "/sessions/new",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessionId: "new-session-id" }),
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const root = createRootRoute({ component: Outlet });
  const newRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/new",
    component: () => (
      <ChatInput
        sessionId={props.sessionId}
        isRunning={props.isRunning}
        pendingInterrupt={props.pendingInterrupt}
      />
    ),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$id",
    component: () => <div>session page</div>,
  });

  const router = createRouter({
    routeTree: root.addChildren([newRoute, sessionRoute]),
    history: createMemoryHistory({ initialEntries: [routePath] }),
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

  return { fetchMock: vi.mocked(fetch) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatInput", () => {
  describe("idle state (isRunning=false)", () => {
    it("renders an enabled textarea and send button", async () => {
      setup({ sessionId: null, isRunning: false });

      const textarea = await screen.findByRole("textbox");
      const button = screen.getByRole("button", { name: /send/i });

      expect(textarea).not.toBeDisabled();
      expect(button).not.toBeDisabled();
    });
  });

  describe("running state (isRunning=true)", () => {
    it("disables the textarea and send button while agent is running", async () => {
      setup({ sessionId: null, isRunning: true });

      const textarea = await screen.findByRole("textbox");
      const button = screen.getByRole("button", { name: /send/i });

      expect(textarea).toBeDisabled();
      expect(button).toBeDisabled();
    });
  });

  describe("submit from new session (sessionId=null)", () => {
    it("calls POST /api/chat and navigates to the new session", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ sessionId: null, isRunning: false });

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Is nginx down?");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "Is nginx down?" }),
        }),
      );

      await screen.findByText("session page");
    });
  });

  describe("submit from existing session (sessionId set)", () => {
    it("calls POST /api/sessions/:id/messages", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(
        { sessionId: "s1", isRunning: false },
        "/sessions/new",
      );

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Why did that tool call fail?");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "Why did that tool call fail?" }),
        }),
      );
    });
  });

  describe("pending interrupt routing", () => {
    it("posts to /respond with text when pendingInterrupt.kind is approval", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(
        {
          sessionId: "s1",
          isRunning: false,
          pendingInterrupt: { id: "inc-1", kind: "approval" },
        },
        "/sessions/new",
      );

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Keep the container up for now");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            text: "Keep the container up for now",
            resolvedBy: "console",
          }),
        }),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/sessions/s1/messages",
        expect.anything(),
      );
    });

    it("posts to /respond with text when pendingInterrupt.kind is clarification", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(
        {
          sessionId: "s1",
          isRunning: false,
          pendingInterrupt: { id: "inc-2", kind: "clarification" },
        },
        "/sessions/new",
      );

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Focus on memory pressure");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            text: "Focus on memory pressure",
            resolvedBy: "console",
          }),
        }),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/sessions/s1/messages",
        expect.anything(),
      );
    });

    it("shows 'Add context...' placeholder when approval interrupt is pending", async () => {
      setup(
        {
          sessionId: "s1",
          isRunning: false,
          pendingInterrupt: { id: "inc-1", kind: "approval" },
        },
        "/sessions/new",
      );

      const textarea = await screen.findByRole("textbox");
      expect(textarea).toHaveAttribute("placeholder", "Add context…");
    });

    it("shows 'Type your answer...' placeholder when clarification interrupt is pending", async () => {
      setup(
        {
          sessionId: "s1",
          isRunning: false,
          pendingInterrupt: { id: "inc-2", kind: "clarification" },
        },
        "/sessions/new",
      );

      const textarea = await screen.findByRole("textbox");
      expect(textarea).toHaveAttribute("placeholder", "Type your answer…");
    });
  });
});
