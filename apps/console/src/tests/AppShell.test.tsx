import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";

import { TestProviders } from "./renderWithProviders.js";
import { routeTree } from "@/router";
import { MockEventSource } from "./mockEventSource.js";

const OWNER_EMAIL = "admin@example.com";

const SESSION_1 = {
  sessionId: "s1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: false,
  severity: null,
  status: null,
  awaitingHumanInput: false,
};

// The real route tree, not a copy of it: the redirect, the two session route
// families and the pages they land on are exactly what ships.
function setup({
  path = "/agent",
  width = 1280,
}: { path?: string; width?: number } = {}) {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("innerWidth", width);

  // What the session says it is. This is what the layout keys on.
  let investigation = false;
  const setInvestigation = (value: boolean): void => {
    investigation = value;
  };

  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ownerExists: true,
            authenticated: true,
            email: OWNER_EMAIL,
          }),
      });
    }
    if (url.includes("/chat")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessionId: "new-s1" }),
      });
    }
    if (url.includes("/runners") || url.includes("/remediation-actions")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    // Configured, so the page has a status line to put in its controls row.
    if (url.includes("/integrations/alertmanager")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            configured: true,
            lastReceivedAt: new Date().toISOString(),
          }),
      });
    }
    if (url.includes("/integrations/")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ configured: false, lastReceivedAt: null }),
      });
    }
    if (url.includes("/report")) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "no report for session" }),
      });
    }
    if (/\/sessions\/[^?]+/.test(url)) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessionId: "new-s1",
            title: "Check disk",
            createdAt: "2026-06-13T00:00:00.000Z",
            investigation,
            alerts: [],
            transcript: [],
          }),
      });
    }
    if (url.includes("/sessions")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rows: [SESSION_1], nextOffset: null }),
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

  return { router, qc, fetchMock, setInvestigation };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// jsdom applies no CSS, so the expanded/rail distinction is only legible as the
// state the sidebar publishes for the CSS to key on. At the overlay tier the
// element is absent entirely, which is the point of that tier.
function sidebarState(): string | null {
  const el = document.querySelector('[data-slot="sidebar"]');
  return el === null ? null : el.getAttribute("data-state");
}

// The bar says where you are through the breadcrumb's current entry. Scoped to
// the nav, because an active sidebar link carries aria-current too.
async function currentCrumb(): Promise<HTMLElement> {
  const nav = await screen.findByRole("navigation", { name: "breadcrumb" });
  return within(nav).getByRole("link", { current: "page" });
}

function precedes(a: HTMLElement, b: HTMLElement): boolean {
  return (
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

describe("Shell", () => {
  describe("the sidebar holds only navigation", () => {
    it("renders the four destinations, then Settings and Log out", async () => {
      setup();

      const agent = await screen.findByRole("link", { name: "Agent" });
      const investigations = screen.getByRole("link", {
        name: "Investigations",
      });
      const integrations = screen.getByRole("link", { name: "Integrations" });
      const audit = screen.getByRole("link", { name: "Audit log" });
      // Settings is a place with an address of its own, so it links like the
      // four above it; only Log out remains an action.
      const settings = screen.getByRole("link", { name: "Settings" });
      const logOut = screen.getByRole("button", { name: "Log out" });

      expect(precedes(agent, investigations)).toBe(true);
      expect(precedes(investigations, integrations)).toBe(true);
      expect(precedes(integrations, audit)).toBe(true);
      expect(precedes(audit, settings)).toBe(true);
      expect(precedes(settings, logOut)).toBe(true);
    });

    it("carries no session list and no new-session action", async () => {
      setup();

      await screen.findByRole("link", { name: "Agent" });
      expect(
        screen.queryByRole("button", { name: /new session/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.queryByText("CPU spike on web-01"),
        ).not.toBeInTheDocument();
      });
    });

    it("Log out posts /api/logout", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      await user.click(await screen.findByRole("button", { name: "Log out" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/logout",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });

  describe("routes", () => {
    it("opens on Investigations rather than a chat greeting", async () => {
      const { router } = setup({ path: "/" });

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations");
      });
      expect(await currentCrumb()).toHaveTextContent("Investigations");
    });
  });

  describe("the top bar", () => {
    it("gives a page with no controls a lone crumb and no controls row", async () => {
      setup({ path: "/audit" });

      expect(await currentCrumb()).toHaveTextContent("Audit log");
      // One entry and no ancestor above it, so no chevron is drawn.
      expect(
        within(
          screen.getByRole("navigation", { name: "breadcrumb" }),
        ).getAllByRole("link"),
      ).toHaveLength(1);
      expect(
        screen.queryByRole("group", { name: /page controls/i }),
      ).not.toBeInTheDocument();
    });

    it("gives a record its breadcrumb, with the collection linked", async () => {
      setup({ path: "/integrations/alertmanager" });

      expect(await currentCrumb()).toHaveTextContent("Alertmanager");
      // The breadcrumb absorbed the standalone back link: the way up is the
      // first crumb, not a separate control above the title.
      const crumb = within(
        screen.getByRole("navigation", { name: "breadcrumb" }),
      ).getByRole("link", { name: "Integrations" });
      expect(crumb).toHaveAttribute("href", "/integrations");
    });

    it("renders the controls row on a page that has controls", async () => {
      setup({ path: "/integrations/alertmanager" });

      const controls = await screen.findByRole("group", {
        name: /page controls/i,
      });
      expect(controls).toHaveTextContent(/receiving/i);
    });
  });

  describe("the three width tiers", () => {
    it("at 1024 and up toggles between expanded and the icon rail, keeping the toggle in the sidebar", async () => {
      const user = userEvent.setup();
      setup({ width: 1280 });

      await waitFor(() => expect(sidebarState()).toBe("expanded"));
      const toggle = screen.getByRole("button", { name: /toggle sidebar/i });

      await user.click(toggle);
      await waitFor(() => expect(sidebarState()).toBe("collapsed"));

      // The rail keeps the control that expands it again, and every
      // destination stays reachable by name.
      expect(
        screen.getByRole("button", { name: /toggle sidebar/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Investigations" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /toggle sidebar/i }));
      await waitFor(() => expect(sidebarState()).toBe("expanded"));
    });

    it("between 768 and 1023 hides the sidebar entirely and moves its toggle into the stage", async () => {
      const user = userEvent.setup();
      setup({ width: 900 });

      // Nothing of the sidebar is on screen - not even a rail - so the control
      // that reopens it cannot be inside it.
      await waitFor(() => expect(sidebarState()).toBeNull());
      expect(
        screen.queryByRole("link", { name: "Investigations" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /toggle sidebar/i }));

      expect(
        await screen.findByRole("link", { name: "Investigations" }),
      ).toBeInTheDocument();
    });

    it("below 768 says the console is built for desktop", async () => {
      setup({ width: 500 });

      expect(
        await screen.findByRole("heading", { name: /built for desktop/i }),
      ).toBeInTheDocument();
      expect(sidebarState()).toBeNull();
    });
  });

  describe("the persistent chat", () => {
    it("submitting from /agent navigates to /agent/:id without a remount", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      const textarea = await screen.findByRole("textbox");
      const streamBefore = MockEventSource.latest;
      expect(streamBefore).not.toBeNull();

      await user.type(textarea, "Check disk usage on prod");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // The one transition ticket 016 depends on: the agent promotes a session
    // and the URL changes families underneath a chat that is mid-stream.
    it("keeps a streaming run alive across the /agent to /investigations split", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });

      // This text exists only in the live view's own state - the server has no
      // record of it, so nothing can re-fetch it after a remount.
      act(() => {
        MockEventSource.broadcast({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "new-s1",
            kind: "text",
            delta: "Analyzing disk usage...",
          },
        });
      });
      await screen.findByText("Analyzing disk usage...");
      const streamBefore = MockEventSource.latest;

      // What the promotion does to the address: replaced, not pushed, and
      // across route families.
      await act(async () => {
        await router.navigate({
          to: "/investigations/$id",
          params: { id: "new-s1" },
          replace: true,
        });
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/new-s1");
      });

      // Only a surviving instance can still be holding this.
      expect(screen.getByText("Analyzing disk usage...")).toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("morphs to the investigation layout on the session's own flag, with no report", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      const streamBefore = MockEventSource.latest;

      setInvestigation(true);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-1",
          type: "MESSAGE",
          payload: {
            sessionId: "new-s1",
            message: {
              kind: "assistant",
              content: "Opening an investigation.",
            },
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation chat/i }),
        ).toBeInTheDocument();
      });
      // No report row exists, and the panel says so rather than rendering blank.
      expect(
        screen.getByText(/has not recorded a finding yet/i),
      ).toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);
    });
  });

  describe("the chat rail", () => {
    // The toggle is a sibling of the panel, so closing the panel cannot take
    // the control that reopens it with it.
    it("collapses and reopens without interrupting the live stream", async () => {
      const user = userEvent.setup();
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      const railed = await screen.findByRole("complementary", {
        name: /investigation chat/i,
      });
      expect(railed).toBeInTheDocument();
      const streamBefore = MockEventSource.latest;

      await user.click(screen.getByRole("button", { name: /hide the chat/i }));

      await waitFor(() => {
        expect(
          screen.queryByRole("complementary", { name: /investigation chat/i }),
        ).not.toBeInTheDocument();
      });
      await user.click(screen.getByRole("button", { name: /show the chat/i }));

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation chat/i }),
        ).toBeInTheDocument();
      });
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });
});
