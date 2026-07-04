import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { RemediationActionRecord } from "@nightwatch/shared";

import { AuditLogPage } from "../pages/AuditLog.js";

const EXECUTED_DOCKER: RemediationActionRecord = {
  sessionId: "sess-audit-1",
  toolUseId: "tu-1",
  serviceIdentityKey: "docker/svc-01/api",
  toolName: "restart_service",
  status: "executed",
  resolvedBy: "operator",
  createdAt: "2024-01-01T00:00:00.000Z",
  resolvedAt: "2024-01-01T00:00:05.000Z",
};

const REJECTED_K8S: RemediationActionRecord = {
  sessionId: "sess-audit-2",
  toolUseId: "tu-2",
  serviceIdentityKey: "kubernetes/prod/checkout",
  toolName: "exec_command",
  status: "rejected",
  resolvedBy: "console",
  createdAt: "2024-02-01T00:00:00.000Z",
  resolvedAt: "2024-02-01T00:00:00.000Z",
};

const STILL_EXECUTING: RemediationActionRecord = {
  sessionId: "sess-audit-3",
  toolUseId: "tu-3",
  serviceIdentityKey: "docker/svc-01/api",
  toolName: "restart_service",
  status: "executing",
  resolvedBy: "operator",
  createdAt: "2024-03-01T00:00:00.000Z",
  resolvedAt: null,
};

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
  describe("table semantics", () => {
    it("renders a semantic table with column headers", async () => {
      setup([EXECUTED_DOCKER]);
      await waitFor(() => {
        expect(screen.getByText("restart_service")).toBeInTheDocument();
      });
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /action/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /service/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /outcome/i }),
      ).toBeInTheDocument();
    });

    it("uses tnum on timestamp and identity cells", async () => {
      setup([EXECUTED_DOCKER]);
      await waitFor(() => {
        expect(screen.getByText("restart_service")).toBeInTheDocument();
      });
      const monoCells = document.querySelectorAll("td.tabular-nums");
      expect(monoCells.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("data rendering", () => {
    it("fetches GET /api/remediation-actions on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/remediation-actions");
      });
    });

    it("renders identity, action, outcome, and resolver for a recorded action", async () => {
      setup([EXECUTED_DOCKER]);
      await waitFor(() => {
        expect(screen.getByText("docker/svc-01/api")).toBeInTheDocument();
      });
      expect(screen.getByText("restart_service")).toBeInTheDocument();
      expect(screen.getByText(/^executed$/i)).toBeInTheDocument();
      expect(screen.getByText("operator")).toBeInTheDocument();
    });

    it("renders a Kubernetes identity key verbatim, same as a Docker one (no hardcoded shape)", async () => {
      setup([REJECTED_K8S]);
      await waitFor(() => {
        expect(
          screen.getByText("kubernetes/prod/checkout"),
        ).toBeInTheDocument();
      });
      expect(screen.getByText(/^rejected$/i)).toBeInTheDocument();
      expect(screen.getByText("console")).toBeInTheDocument();
    });

    it("lists newest-first order as returned by the API, without re-sorting", async () => {
      setup([REJECTED_K8S, EXECUTED_DOCKER]);
      await waitFor(() => {
        expect(
          screen.getByText("kubernetes/prod/checkout"),
        ).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("row");
      const dataRows = rows.slice(1);
      expect(dataRows).toHaveLength(2);
      expect(dataRows[0].textContent).toContain("kubernetes/prod/checkout");
      expect(dataRows[1].textContent).toContain("docker/svc-01/api");
    });

    it("shows in progress for a crash-interrupted action stuck in executing", async () => {
      setup([STILL_EXECUTING]);
      await waitFor(() => {
        expect(screen.getByText(/^executing$/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/in progress/i)).toBeInTheDocument();
    });

    it("truncates long cell values with a title attribute", async () => {
      setup([EXECUTED_DOCKER]);
      await waitFor(() => {
        expect(screen.getByText("restart_service")).toBeInTheDocument();
      });
      const toolCell = screen.getByText("restart_service");
      expect(toolCell.getAttribute("title")).toBe("restart_service");
    });
  });

  describe("empty state", () => {
    it("shows the Linear two-region empty state when there are no recorded actions", async () => {
      setup([]);
      await waitFor(() => {
        expect(
          screen.getByText(/no remediation actions recorded/i),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole("heading", { name: /audit log/i }),
      ).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("shows skeleton rows while loading", () => {
      setup();
      expect(
        screen.getByRole("status", { name: /loading audit log/i }),
      ).toBeInTheDocument();
      expect(document.querySelectorAll("[data-slot=\"skeleton\"]").length).toBeGreaterThan(0);
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
