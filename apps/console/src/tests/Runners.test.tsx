import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { RunnerRecord } from "@nightwatch/shared";

import { RunnersPage } from "../pages/Runners.js";
import { theme, cssVariablesResolver } from "../theme.js";

const NOW = new Date("2024-01-01T12:00:00Z").getTime();

const AWAITING_RUNNER: RunnerRecord = {
  id: "token-uuid-1",
  token: "token-uuid-1",
  hostname: null,
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: null,
  manifest: null,
  remediationMode: null,
};

const ONLINE_RUNNER: RunnerRecord = {
  id: "runner-uuid-2",
  token: "token-uuid-2",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(),
  manifest: null,
  remediationMode: false,
};

const OFFLINE_RUNNER: RunnerRecord = {
  id: "runner-uuid-3",
  token: "token-uuid-3",
  hostname: "db-02",
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: new Date(NOW - 5 * 60 * 1000).toISOString(),
  manifest: null,
  remediationMode: false,
};

const GENERATED_TOKEN = {
  id: "new-token-uuid",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
  label: null,
  createdAt: new Date().toISOString(),
};

const CONNECT_SCRIPT = `#!/bin/sh
export NIGHTWATCH_TOKEN=nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345
export NIGHTWATCH_URL=http://localhost:3000
curl -fsSL $NIGHTWATCH_URL/runner | sh`;

function setup(runners: RunnerRecord[] = []) {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runners),
        });
      }
      if (url === "/api/tokens" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(GENERATED_TOKEN),
        });
      }
      if (url.startsWith("/api/tokens/") && init?.method === "DELETE") {
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
        });
      }
      if (url.startsWith("/api/connect.sh")) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(CONNECT_SCRIPT),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <RunnersPage />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock, clipboardWrite, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunnersPage", () => {
  describe("fleet list", () => {
    it("fetches GET /api/runners on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/runners");
      });
    });

    it("shows 'awaiting connection' for a runner with no hostname", async () => {
      setup([AWAITING_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText(/awaiting connection/i)).toBeInTheDocument();
      });
    });

    it("shows 'online' with hostname and last-seen for an online runner", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([ONLINE_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      expect(screen.getByText(/^online$/i)).toBeInTheDocument();
      expect(screen.getByText("30s ago")).toBeInTheDocument();
    });

    it("shows 'offline' with hostname and last-seen for a stale runner", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([OFFLINE_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("db-02")).toBeInTheDocument();
      });
      expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
      expect(screen.getByText("5m ago")).toBeInTheDocument();
    });

    it("re-polls every 30s, picking up a runner that has gone offline", async () => {
      vi.useFakeTimers();
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        call += 1;
        const online = call === 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ ...ONLINE_RUNNER, online }]),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <RunnersPage />
          </QueryClientProvider>
        </MantineProvider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/^online$/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const polled = qc.getQueryData<RunnerRecord[]>(["runners"]);
      expect(polled?.[0].online).toBe(false);
    });
  });

  describe("Add a server", () => {
    it("renders an 'Add a server' button", () => {
      setup();
      expect(
        screen.getByRole("button", { name: /add a server/i }),
      ).toBeInTheDocument();
    });

    it("calls POST /api/tokens then GET /api/connect.sh with the token in the Authorization header", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      await user.click(screen.getByRole("button", { name: /add a server/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/tokens",
          expect.objectContaining({ method: "POST" }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/connect.sh",
          expect.objectContaining({
            headers: { Authorization: `Bearer ${GENERATED_TOKEN.token}` },
          }),
        );
      });
    });

    it("shows the connect.sh script panel after clicking Add a server", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole("button", { name: /add a server/i }));

      // getByText normalizes whitespace (collapses newlines), so match a
      // distinctive single-line token from the script instead.
      await waitFor(() => {
        expect(
          screen.getByText(new RegExp(GENERATED_TOKEN.token)),
        ).toBeInTheDocument();
      });
    });

    it("shows a 'won't see this again' warning", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole("button", { name: /add a server/i }));

      await waitFor(() => {
        expect(screen.getByText(/won't see this again/i)).toBeInTheDocument();
      });
    });

    it("copies the script to clipboard when copy button is clicked", async () => {
      const user = userEvent.setup();
      const { clipboardWrite } = setup();

      await user.click(screen.getByRole("button", { name: /add a server/i }));
      // Wait for panel (warning is a reliable single-line marker).
      await waitFor(() => {
        expect(screen.getByText(/won't see this again/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /copy/i }));
      expect(clipboardWrite).toHaveBeenCalledWith(CONNECT_SCRIPT);
    });

    it("new row appears as 'awaiting connection' after adding (via runners refetch)", async () => {
      const user = userEvent.setup();
      let runnersCallCount = 0;
      const newRunner: RunnerRecord = {
        id: GENERATED_TOKEN.id,
        token: GENERATED_TOKEN.id,
        hostname: null,
        createdAt: GENERATED_TOKEN.createdAt,
        online: false,
        lastSeen: null,
        manifest: null,
        remediationMode: null,
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/runners") {
            runnersCallCount += 1;
            const result = runnersCallCount === 1 ? [] : [newRunner];
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(result),
            });
          }
          if (url === "/api/tokens" && init?.method === "POST") {
            return Promise.resolve({
              ok: true,
              status: 201,
              json: () => Promise.resolve(GENERATED_TOKEN),
            });
          }
          if (url.startsWith("/api/connect.sh")) {
            return Promise.resolve({
              ok: true,
              text: () => Promise.resolve(CONNECT_SCRIPT),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <RunnersPage />
          </QueryClientProvider>
        </MantineProvider>,
      );

      await user.click(screen.getByRole("button", { name: /add a server/i }));

      await waitFor(() => {
        expect(screen.getByText(/awaiting connection/i)).toBeInTheDocument();
      });
    });
  });

  describe("Remove", () => {
    it("shows a Remove button for each runner", async () => {
      setup([ONLINE_RUNNER]);
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /remove/i }),
        ).toBeInTheDocument();
      });
    });

    it("calls DELETE /api/tokens/:tokenId when Remove is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup([ONLINE_RUNNER]);

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/tokens/${ONLINE_RUNNER.token}`,
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });

    it("row disappears after Remove (via runners refetch)", async () => {
      const user = userEvent.setup();
      let runnersCallCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/runners") {
            runnersCallCount += 1;
            const result = runnersCallCount === 1 ? [ONLINE_RUNNER] : [];
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(result),
            });
          }
          if (url.startsWith("/api/tokens/") && init?.method === "DELETE") {
            return Promise.resolve({
              ok: true,
              status: 204,
              json: () => Promise.resolve({}),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <RunnersPage />
          </QueryClientProvider>
        </MantineProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(screen.queryByText("web-01")).not.toBeInTheDocument();
      });
    });
  });

  describe("jargon", () => {
    it("does not use 'mint' or 'revoke' anywhere in the UI", async () => {
      setup([ONLINE_RUNNER, AWAITING_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).not.toContain("mint");
      expect(text.toLowerCase()).not.toContain("revoke");
    });
  });
});
