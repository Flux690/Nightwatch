import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { RemediationActionRecord } from "@nightwatch/shared";

import { AuditLogPage } from "../pages/AuditLog.js";

function setup(actions: RemediationActionRecord[] = []) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/remediation-actions") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(actions),
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
        <AuditLogPage />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuditLogPage", () => {
  describe("data rendering", () => {
    it("fetches GET /api/remediation-actions on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/remediation-actions");
      });
    });
  });

  describe("error state", () => {
    it("shows an error alert when the fetch fails", async () => {
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
            <AuditLogPage />
          </QueryClientProvider>
        </TestProviders>,
      );

      await waitFor(() => {
        expect(
          screen.getByText(/failed to load audit log/i),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText(/no remediation actions/i),
      ).not.toBeInTheDocument();
    });
  });
});
