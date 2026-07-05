import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";

import { UnresolvedAlertsPage } from "../pages/UnresolvedAlerts.js";

function setup(alerts: UnresolvedAlertRecord[] = []) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/unresolved-alerts") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(alerts),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <UnresolvedAlertsPage />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UnresolvedAlertsPage", () => {
  describe("data rendering", () => {
    it("fetches GET /api/unresolved-alerts on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/unresolved-alerts");
      });
    });
  });

  describe("error state", () => {
    it("shows an error alert when the fetch fails and does not show the empty state", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      render(
        <TestProviders>
          <QueryClientProvider client={qc}>
            <UnresolvedAlertsPage />
          </QueryClientProvider>
        </TestProviders>,
      );

      await waitFor(() => {
        expect(
          screen.getByText(/failed to load unresolved alerts/i),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText(/no unresolved alerts/i),
      ).not.toBeInTheDocument();
    });
  });
});
