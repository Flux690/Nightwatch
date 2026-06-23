import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { RemediationActionRecord } from "@nightwatch/shared";

import { AuditLogPage } from "../pages/AuditLog.js";
import { theme, cssVariablesResolver } from "../theme.js";

const EXECUTED_DOCKER: RemediationActionRecord = {
  toolUseId: "tu-1",
  serviceIdentityKey: "docker/svc-01/api",
  toolName: "restart_container",
  status: "executed",
  resolvedBy: "operator",
  createdAt: "2024-01-01T00:00:00.000Z",
  resolvedAt: "2024-01-01T00:00:05.000Z",
};

const REJECTED_K8S: RemediationActionRecord = {
  toolUseId: "tu-2",
  serviceIdentityKey: "kubernetes/prod/checkout",
  toolName: "exec_command",
  status: "rejected",
  resolvedBy: "console",
  createdAt: "2024-02-01T00:00:00.000Z",
  resolvedAt: "2024-02-01T00:00:00.000Z",
};

const STILL_EXECUTING: RemediationActionRecord = {
  toolUseId: "tu-3",
  serviceIdentityKey: "docker/svc-01/api",
  toolName: "restart_container",
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
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <AuditLogPage />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuditLogPage", () => {
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
    expect(screen.getByText("restart_container")).toBeInTheDocument();
    expect(screen.getByText(/^executed$/i)).toBeInTheDocument();
    expect(screen.getByText(/operator/)).toBeInTheDocument();
  });

  it("renders a Kubernetes identity key verbatim, same as a Docker one (no hardcoded shape)", async () => {
    setup([REJECTED_K8S]);
    await waitFor(() => {
      expect(screen.getByText("kubernetes/prod/checkout")).toBeInTheDocument();
    });
    expect(screen.getByText(/^rejected$/i)).toBeInTheDocument();
    expect(screen.getByText(/console/)).toBeInTheDocument();
  });

  it("lists newest-first order as returned by the API, without re-sorting", async () => {
    setup([REJECTED_K8S, EXECUTED_DOCKER]);
    await waitFor(() => {
      expect(screen.getByText("kubernetes/prod/checkout")).toBeInTheDocument();
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("kubernetes/prod/checkout");
    expect(rows[1].textContent).toContain("docker/svc-01/api");
  });

  it("shows an empty state when there are no recorded actions", async () => {
    setup([]);
    await waitFor(() => {
      expect(screen.getByText(/no remediation actions/i)).toBeInTheDocument();
    });
  });

  it("shows the action never resolved, for a crash-interrupted write stuck in executing", async () => {
    setup([STILL_EXECUTING]);
    await waitFor(() => {
      expect(screen.getByText(/^executing$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/resolved never/i)).toBeInTheDocument();
  });
});
