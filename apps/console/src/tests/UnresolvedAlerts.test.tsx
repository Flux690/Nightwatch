import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";

import { UnresolvedAlertsPage } from "../pages/UnresolvedAlerts.js";

const UNMATCHED: UnresolvedAlertRecord = {
  sourceAlertId: "fp-abc123",
  identityKey: "docker/myproject/api",
  alertType: "HighCPU",
  severity: "warning",
  rejectionReason:
    "No runner advertises service 'docker/myproject/api'. Known services: none.",
  createdAt: "2024-06-01T00:00:00.000Z",
};

const AMBIGUOUS: UnresolvedAlertRecord = {
  sourceAlertId: "fp-def456",
  identityKey: "docker/myproject/web",
  alertType: "HighMemory",
  severity: "critical",
  rejectionReason:
    "Ambiguous service 'docker/myproject/web': advertised by more than one runner.",
  createdAt: "2024-06-02T00:00:00.000Z",
};

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
  describe("table semantics", () => {
    it("renders a semantic table with column headers", async () => {
      setup([UNMATCHED]);
      await waitFor(() => {
        expect(screen.getByText("docker/myproject/api")).toBeInTheDocument();
      });
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /alert/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /identity/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /severity/i }),
      ).toBeInTheDocument();
    });

    it("uses tnum on alert type, identity, and time cells", async () => {
      setup([UNMATCHED]);
      await waitFor(() => {
        expect(screen.getByText("docker/myproject/api")).toBeInTheDocument();
      });
      const monoCells = document.querySelectorAll("td.tabular-nums");
      expect(monoCells.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("data rendering", () => {
    it("fetches GET /api/unresolved-alerts on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/unresolved-alerts");
      });
    });

    it("renders identity key, alert type, severity, and rejection reason for an unresolved alert", async () => {
      setup([UNMATCHED]);
      await waitFor(() => {
        expect(screen.getByText("docker/myproject/api")).toBeInTheDocument();
      });
      expect(screen.getByText("HighCPU")).toBeInTheDocument();
      expect(screen.getByText(/warning/i)).toBeInTheDocument();
      expect(screen.getByText(/No runner advertises/)).toBeInTheDocument();
    });

    it("renders a critical severity chip", async () => {
      setup([AMBIGUOUS]);
      await waitFor(() => {
        expect(screen.getByText("docker/myproject/web")).toBeInTheDocument();
      });
      expect(screen.getByText(/critical/i)).toBeInTheDocument();
      expect(screen.getByText(/Ambiguous service/)).toBeInTheDocument();
    });

    it("lists newest-first order as returned by the API, without re-sorting", async () => {
      setup([AMBIGUOUS, UNMATCHED]);
      await waitFor(() => {
        expect(screen.getByText("docker/myproject/web")).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("row");
      const dataRows = rows.slice(1);
      expect(dataRows).toHaveLength(2);
      expect(dataRows[0]!.textContent).toContain("docker/myproject/web");
      expect(dataRows[1]!.textContent).toContain("docker/myproject/api");
    });

    it("truncates long cell values with a title attribute", async () => {
      setup([UNMATCHED]);
      await waitFor(() => {
        expect(screen.getByText("HighCPU")).toBeInTheDocument();
      });
      const alertCell = screen.getByText("HighCPU");
      expect(alertCell.getAttribute("title")).toBe("HighCPU");
    });
  });

  describe("empty state", () => {
    it("shows the Linear two-region empty state when there are no unresolved alerts", async () => {
      setup([]);
      await waitFor(() => {
        expect(screen.getByText(/no unresolved alerts/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("heading", { level: 1, name: /unresolved alerts/i }),
      ).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows skeleton rows while loading", () => {
      setup();
      expect(
        screen.getByRole("status", { name: /loading unresolved alerts/i }),
      ).toBeInTheDocument();
      expect(document.querySelectorAll("[data-slot=\"skeleton\"]").length).toBeGreaterThan(0);
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
