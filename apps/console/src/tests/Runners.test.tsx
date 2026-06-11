import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { RunnerRecord } from "@nightwatch/shared";

import { RunnersPage } from "../pages/Runners.js";
import { theme, cssVariablesResolver } from "../theme.js";

const NOW = new Date("2024-01-01T12:00:00Z").getTime();

const ONLINE_RUNNER = {
  id: "abcdef1234567890",
  token: "tok-1",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(), // 30s ago
  manifest: null,
};

const OFFLINE_RUNNER = {
  id: "fedcba0987654321",
  token: "tok-1",
  hostname: "db-02",
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago
  manifest: null,
};

function setup(runners: object[] = [ONLINE_RUNNER, OFFLINE_RUNNER]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(runners),
      }),
    ),
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

  return { fetchMock: vi.mocked(fetch) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunnersPage", () => {
  it("fetches GET /api/runners on mount and renders a row per runner", async () => {
    const { fetchMock } = setup();

    await waitFor(() => {
      expect(screen.getByText("web-01")).toBeInTheDocument();
    });
    expect(screen.getByText("db-02")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/runners");
  });

  it("shows the runnerId truncated to the first 8 chars", async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText("web-01")).toBeInTheDocument();
    });
    expect(screen.getByText(/abcdef12/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef1234567890/)).not.toBeInTheDocument();
  });

  it("derives an online/offline badge from the online field", async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText("online")).toBeInTheDocument();
    });
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("renders lastSeen as a relative time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    setup();

    await waitFor(() => {
      expect(screen.getByText("web-01")).toBeInTheDocument();
    });
    // online runner last seen 30s ago, offline 5 min ago
    expect(screen.getByText("30s ago")).toBeInTheDocument();
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("re-polls every 30s, picking up a runner that has gone offline", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1;
      const online = call === 1; // online on the first poll, offline thereafter
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
    expect(screen.getByText("online")).toBeInTheDocument();

    // No WS invalidation: the badge only flips when the next scheduled poll
    // (within 30s) observes the runner's heartbeat gone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const polled = qc.getQueryData<RunnerRecord[]>(["runners"]);
    expect(polled?.[0].online).toBe(false);
  });
});
