import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";

import { ChatInput } from "@/components/transcript/ChatInput";

function setup(
  props: {
    sessionId: string | null;
    isRunning: boolean;
  },
  routePath = "/agent",
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
    path: "/agent",
    component: () => (
      <ChatInput sessionId={props.sessionId} isRunning={props.isRunning} />
    ),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => root,
    path: "/agent/$id",
    component: () => <div>session page</div>,
  });

  const router = createRouter({
    routeTree: root.addChildren([newRoute, sessionRoute]),
    history: createMemoryHistory({ initialEntries: [routePath] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock: vi.mocked(fetch) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatInput", () => {
  describe("idle state (isRunning=false)", () => {
    it("renders an enabled textarea and a send button that enables on input", async () => {
      const user = userEvent.setup();
      setup({ sessionId: null, isRunning: false });

      const textarea = await screen.findByRole("textbox");
      const button = screen.getByRole("button", { name: /send/i });

      expect(textarea).not.toBeDisabled();
      expect(button).toBeDisabled();

      await user.type(textarea, "hello");
      expect(button).not.toBeDisabled();
    });
  });

  describe("running state (isRunning=true)", () => {
    it("disables the textarea and shows a stop button while agent is running", async () => {
      setup({ sessionId: null, isRunning: true });

      const textarea = await screen.findByRole("textbox");

      expect(textarea).toBeDisabled();
      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /send/i }),
      ).not.toBeInTheDocument();
    });

    it("posts to /api/sessions/:id/stop when the stop button is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ sessionId: "s1", isRunning: true });

      const stopButton = await screen.findByRole("button", { name: /stop/i });
      await user.click(stopButton);

      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/stop", {
        method: "POST",
      });
    });
  });

  describe("submit from new session (sessionId=null)", () => {
    it("calls POST /api/chat with the message alone and navigates", async () => {
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
    it("calls POST /api/sessions/:id/messages with the message alone", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(
        { sessionId: "s1", isRunning: false },
        "/agent",
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

    // There is no mode to choose: the agent opens an investigation itself.
    it("offers no mode picker at all", async () => {
      setup({ sessionId: "s1", isRunning: false }, "/agent");

      await screen.findByRole("textbox");
      expect(
        screen.queryByRole("button", { name: /session mode/i }),
      ).not.toBeInTheDocument();
    });
  });
});
