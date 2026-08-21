import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";

import type { SessionAlert, SessionListRow } from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { routeTree } from "@/router";
import { MockEventSource } from "./mockEventSource.js";

const OWNER_EMAIL = "admin@example.com";

const SESSION_1: SessionListRow = {
  sessionId: "s1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: false,
  severity: null,
  severityLabel: null,
  status: null,
  finding: null,
  awaitingHumanInput: false,
};

function investigationRow(
  sessionId: string,
  title: string,
  overrides: Partial<SessionListRow> = {},
): SessionListRow {
  return {
    ...SESSION_1,
    sessionId,
    title,
    createdAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    lastActivityAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    investigation: true,
    ...overrides,
  };
}

// Two in one group so severity has something to order, a status per group so
// the triage order is visible, and one row carrying no severity at all.
const INVESTIGATIONS = [
  // Listed first, and ordered second: "P1" is a word we cannot rank.
  investigationRow("inv-p1", "Checkout latency spike", {
    severity: null,
    severityLabel: "P1",
    status: "action_required",
    finding: "Raise the pod memory limit",
  }),
  // Opened fourteen minutes ago, moved two: the row reads the second.
  investigationRow("inv-crit", "Container memory high", {
    lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    severity: "critical",
    severityLabel: "critical",
    status: "action_required",
    finding: "Waiting on approval",
  }),
  investigationRow("inv-run", "Redis pool exhausted", {
    severity: "warning",
    severityLabel: "warning",
    status: "investigating",
    finding: "Connection pool starved by the checkout deploy",
  }),
  investigationRow("inv-done", "Disk filling on db-02", {
    status: "resolved",
    finding: "Alert condition recovered",
  }),
];

function alertOn(alertType: string, clearedAt: string | null): SessionAlert {
  return {
    alert: {
      sourceAlertId: `${alertType}-1`,
      labels: { alertname: alertType },
      annotations: {},
      alertType,
      severity: "critical",
      firedAt: "2026-08-19T02:14:00.000Z",
      generatorURL: null,
      values: {},
      rawPayload: null,
    },
    arrivedAt: "2026-08-19T02:14:00.000Z",
    clearedAt,
    injected: false,
    droppedAlerts: 0,
    groupContext: null,
  };
}

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

  // What a record's own fetch answers, so a case can change it under an open
  // page the way the recovery sweep does.
  let alerts: SessionAlert[] = [];
  const setAlerts = (next: SessionAlert[]): void => {
    alerts = next;
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
    if (url.includes("/runners")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    // Configured, so the page has a status line to put in its controls row.
    if (url.includes("/integrations/alerting/alertmanager")) {
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
    const record = /\/sessions\/([^?/]+)$/.exec(url);
    if (record !== null) {
      const id = record[1]!;
      const known = INVESTIGATIONS.find((row) => row.sessionId === id);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessionId: id,
            title: known?.title ?? "Check disk",
            createdAt: "2026-06-13T00:00:00.000Z",
            investigation: known !== undefined || investigation,
            running: false,
            alerts,
            transcript: [],
          }),
      });
    }
    if (url.includes("/sessions")) {
      const rows = url.includes("kind=investigation")
        ? INVESTIGATIONS
        : [SESSION_1];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows,
            nextOffset: null,
            investigationTotal: INVESTIGATIONS.length,
          }),
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

  return { router, qc, fetchMock, setInvestigation, setAlerts };
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
    it("carries no session list, no new-session action and no readouts", async () => {
      setup({ path: "/investigations" });

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

      // A nav item is its name and nothing else. The count that used to sit
      // here said what the page it links to already says, and could not survive
      // the rail. The page is loaded, so the number it would have shown exists.
      await screen.findByRole("region", { name: "Action required" });
      const sidebar = document.querySelector('[data-slot="sidebar"]');
      const item = within(sidebar as HTMLElement).getByRole("link", {
        name: "Investigations",
      });
      expect(item).toHaveTextContent(/^Investigations$/);
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

  // Not sessions, so not rows: a row promises a transcript and something to open.
  // The band names the limit, because raising it is what the reader can do.
  describe("the alert queue band", () => {
    it("says nothing while nothing is waiting", async () => {
      setup({ path: "/investigations" });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());

      expect(screen.queryByText(/alerts? waiting/i)).not.toBeInTheDocument();
    });

    it("appears when alerts are held up, naming the count and the limit", async () => {
      setup({ path: "/investigations" });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());

      act(() => {
        MockEventSource.broadcast({
          messageId: "q1",
          type: "QUEUE_CHANGED",
          payload: {
            waiting: 3,
            running: 10,
            limit: 10,
            oldestArrivedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          },
        });
      });

      expect(await screen.findByText("3 alerts waiting")).toBeInTheDocument();
      expect(
        screen.getByText(/10 of 10 investigations running/),
      ).toBeInTheDocument();

      // It clears itself the moment the last one starts, rather than lingering
      // as a stale claim that work is held up.
      act(() => {
        MockEventSource.broadcast({
          messageId: "q2",
          type: "QUEUE_CHANGED",
          payload: {
            waiting: 0,
            running: 10,
            limit: 10,
            oldestArrivedAt: null,
          },
        });
      });
      await waitFor(() =>
        expect(screen.queryByText(/alerts? waiting/i)).not.toBeInTheDocument(),
      );
    });
  });

  describe("the top bar", () => {
    it("gives a page with no controls a lone crumb and no controls row", async () => {
      setup({ path: "/investigations" });

      expect(await currentCrumb()).toHaveTextContent("Investigations");
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
      setup({ path: "/integrations/alerting/alertmanager" });

      expect(await currentCrumb()).toHaveTextContent("Alertmanager");
      // The breadcrumb absorbed the standalone back link: the way up is the
      // first crumb, not a separate control above the title.
      const crumb = within(
        screen.getByRole("navigation", { name: "breadcrumb" }),
      ).getByRole("link", { name: "Integrations" });
      expect(crumb).toHaveAttribute("href", "/integrations");
    });

    it("renders the controls row on a page that has controls", async () => {
      setup({ path: "/integrations/alerting/alertmanager" });

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
      // The message box renders before the stream opens, so waiting on the textarea
      // and reading the stream is a gap that only closes on an idle machine.
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      await user.type(textarea, "Check disk usage on prod");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // No session crosses between the two families, so nothing has to survive the
    // crossing - which is what let the portal carrying chat between them go.
    it("sends an investigation straight to its record, never through /agent", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByRole("textbox");
      await user.click(screen.getByRole("button", { name: /^mode:/i }));
      await user.click(
        await screen.findByRole("menuitem", { name: /investigate/i }),
      );

      await user.type(screen.getByRole("textbox"), "Why is checkout slow?");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/new-s1");
      });
      // One stream for the run, opened where it was started and never reopened.
      expect(MockEventSource.instances).toHaveLength(1);
    });

    // The layout is the route's and nothing else's. A session flipping to an
    // investigation does not rearrange the page under a user mid-read;
    // the promotion replaces the address, and the address decides.
    it("morphs on the address, not on the session's own flag", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation, fetchMock } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/agent/new-s1");
      });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      const sessionFetches = (): number =>
        fetchMock.mock.calls.filter(
          (call) => call[0] === "/api/sessions/new-s1",
        ).length;
      const before = sessionFetches();

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
      // The flag has demonstrably reached the client, and moved nothing.
      await waitFor(() => expect(sessionFetches()).toBeGreaterThan(before));
      expect(
        screen.queryByRole("complementary", { name: /investigation chat/i }),
      ).not.toBeInTheDocument();

      await act(async () => {
        await router.navigate({
          to: "/investigations/$id",
          params: { id: "new-s1" },
          replace: true,
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
      // The rail mounts before the stream opens, so capturing it any earlier
      // compares null against null and proves nothing.
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
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

    it("takes the width the user gives it, within its floor, and keeps it", async () => {
      const user = userEvent.setup();
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      const handle = await screen.findByRole("separator", {
        name: /resize the chat/i,
      });
      const rail = screen.getByRole("complementary", {
        name: /investigation chat/i,
      });

      // jsdom applies no CSS, so the width is only legible as the custom
      // property the rail writes for the utility to read.
      expect(rail.style.getPropertyValue("--container-rail")).toBe("420px");

      handle.focus();
      await user.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(rail.style.getPropertyValue("--container-rail")).toBe("460px");
      expect(window.localStorage.getItem("nightwarden.rail.width")).toBe("460");

      // Narrower than the floor is not a narrower rail, it is a transcript
      // wrapped to shreds, so the floor holds however far the drag goes.
      await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
      expect(rail.style.getPropertyValue("--container-rail")).toBe("420px");
    });

    it("opens at the width it was left at, not at the default", async () => {
      window.localStorage.setItem("nightwarden.rail.width", "600");
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      const rail = await screen.findByRole("complementary", {
        name: /investigation chat/i,
      });

      // A width set once and lost every night is worse than one you cannot set.
      expect(rail.style.getPropertyValue("--container-rail")).toBe("600px");
    });

    it("expands over the report without unmounting the chat", async () => {
      const user = userEvent.setup();
      const { setInvestigation } = setup({ path: "/investigations/new-s1" });

      setInvestigation(true);
      await screen.findByRole("complementary", { name: /investigation chat/i });
      await waitFor(() => expect(MockEventSource.latest).not.toBeNull());
      const streamBefore = MockEventSource.latest;

      await user.click(
        screen.getByRole("button", { name: /expand the chat/i }),
      );

      // The report is still mounted underneath: expanding covers it, and coming
      // back out must not cost a refetch or the scroll position.
      expect(
        screen.getByRole("heading", { name: "Investigation" }),
      ).toBeInTheDocument();
      // Nothing to drag while it owns the stage, so the handle steps aside.
      expect(
        screen.queryByRole("separator", { name: /resize the chat/i }),
      ).not.toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);

      await user.click(
        screen.getByRole("button", { name: /shrink the chat/i }),
      );
      expect(
        await screen.findByRole("separator", { name: /resize the chat/i }),
      ).toBeInTheDocument();
      expect(MockEventSource.latest).toBe(streamBefore);
    });
  });

  describe("the investigations list", () => {
    it("groups by status in triage order, and renders no empty group", async () => {
      setup({ path: "/investigations" });

      const action = await screen.findByRole("region", {
        name: "Action required",
      });
      const investigating = screen.getByRole("region", {
        name: "Investigating",
      });
      const resolved = screen.getByRole("region", { name: "Resolved" });

      // The header states the status and nothing else; the rows under it are
      // the count, and repeating it as a number adds no reading.
      expect(action).toHaveTextContent("Action required");
      expect(action).not.toHaveTextContent(/Action required\s*\d/);
      expect(within(action).getAllByRole("link")).toHaveLength(2);
      expect(within(investigating).getAllByRole("link")).toHaveLength(1);
      expect(within(resolved).getAllByRole("link")).toHaveLength(1);
      expect(precedes(action, investigating)).toBe(true);
      expect(precedes(investigating, resolved)).toBe(true);

      // Nothing is Failed, so no Failed header is drawn.
      expect(
        screen.queryByRole("region", { name: "Failed" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Inconclusive" }),
      ).not.toBeInTheDocument();
    });

    it("puts the title, the finding, the severity word and the age on one row", async () => {
      setup({ path: "/investigations" });

      const row = await screen.findByRole("link", {
        name: /Container memory high/,
      });
      expect(row).toHaveTextContent("Container memory high");
      expect(row).toHaveTextContent("Waiting on approval");
      // The label's own word, not a vocabulary we imposed on it.
      expect(row).toHaveTextContent("critical");
      /* When it last moved, not when it opened. On a run parked for an answer
         those are different numbers, and only the first one is worth reading. */
      expect(row).toHaveTextContent("2m");
      expect(row).not.toHaveTextContent("14m");
    });

    it("renders an absent severity as nothing rather than a substitute", async () => {
      setup({ path: "/investigations" });

      const row = await screen.findByRole("link", {
        name: /Disk filling on db-02/,
      });
      expect(row).toHaveTextContent("Alert condition recovered");
      expect(row).not.toHaveTextContent(/critical|warning|info|unknown|—/);
    });

    it("orders a group by severity, an unrankable word sorting last", async () => {
      setup({ path: "/investigations" });

      const critical = await screen.findByRole("link", {
        name: /Container memory high/,
      });
      // The API sent "P1" first; severity is what decides the arrangement.
      const unranked = screen.getByRole("link", {
        name: /Checkout latency spike/,
      });
      expect(precedes(critical, unranked)).toBe(true);
    });

    it("opens a row at its own record", async () => {
      const user = userEvent.setup();
      const { router } = setup({ path: "/investigations" });

      await user.click(
        await screen.findByRole("link", { name: /Container memory high/ }),
      );

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/inv-crit");
      });
    });
  });

  describe("the investigation record", () => {
    it("heads the record with a breadcrumb back to the list", async () => {
      setup({ path: "/investigations/inv-crit" });

      await waitFor(async () => {
        expect(await currentCrumb()).toHaveTextContent("Container memory high");
      });
      const back = within(
        screen.getByRole("navigation", { name: "breadcrumb" }),
      ).getByRole("link", { name: "Investigations" });
      expect(back).toHaveAttribute("href", "/investigations");
    });

    it("carries its place in the queue and steps to the next record", async () => {
      const user = userEvent.setup();
      const { router } = setup({ path: "/investigations/inv-crit" });

      // First of four: the critical leads the first group in triage order.
      expect(await screen.findByText("1 / 4")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Next investigation" }),
      );

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations/inv-p1");
      });
      expect(await screen.findByText("2 / 4")).toBeInTheDocument();
      // Nothing navigated back to the list to get there.
      expect(
        screen.queryByRole("region", { name: "Action required" }),
      ).not.toBeInTheDocument();
    });

    /* The sweep clears the alert minutes after the run ended, so the record is
       already open when it happens. */
    it("shows a recovery discovered after the page was opened", async () => {
      const { setAlerts } = setup({ path: "/investigations/inv-done" });
      setAlerts([alertOn("HighMemoryUsage", null)]);

      await screen.findByText("HighMemoryUsage");
      expect(screen.queryByText("Recovered")).not.toBeInTheDocument();

      setAlerts([alertOn("HighMemoryUsage", "2026-08-19T02:31:00.000Z")]);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m1",
          type: "REPORT_UPDATED",
          payload: { sessionId: "inv-done" },
        });
      });

      expect(await screen.findByText("Recovered")).toBeInTheDocument();
    });

    it("offers Copy report as Markdown and Delete, and never Mark as resolved", async () => {
      const user = userEvent.setup();
      setup({ path: "/investigations/inv-crit" });

      await user.click(
        await screen.findByRole("button", { name: "More actions" }),
      );

      expect(
        await screen.findByRole("menuitem", {
          name: "Copy report as Markdown",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Delete" }),
      ).toBeInTheDocument();
      // Status is derived and never declared; this is where a user would
      // most expect to declare it, so it must not be here.
      expect(
        screen.queryByRole("menuitem", { name: /mark as resolved/i }),
      ).not.toBeInTheDocument();
    });

    it("names the record in its delete confirmation and then deletes it", async () => {
      const user = userEvent.setup();
      const { router, fetchMock } = setup({ path: "/investigations/inv-crit" });

      await user.click(
        await screen.findByRole("button", { name: "More actions" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Container memory high");
      await user.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/sessions/inv-crit",
          expect.objectContaining({ method: "DELETE" }),
        );
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/investigations");
      });
    });
  });
});
