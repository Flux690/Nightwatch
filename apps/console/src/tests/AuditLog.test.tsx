import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TestProviders } from "./renderWithProviders.js";
import type { RemediationActionRecord } from "@nightwarden/shared";

import { AuditLogPage } from "../pages/AuditLog.js";

function action(
  overrides: Partial<RemediationActionRecord>,
): RemediationActionRecord {
  return {
    sessionId: "s1",
    toolUseId: "tu-1",
    serviceIdentityKey: "docker:web-01",
    toolName: "RestartDockerService",
    status: "executed",
    resolvedBy: "console",
    result: null,
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

/* The page reads its scope from the URL, so it renders under a memory router
   mirroring the real /audit route's search handling. */
function renderAuditRoute(qc: QueryClient, initialPath: string) {
  const rootRoute = createRootRoute();
  const auditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/audit",
    component: AuditLogPage,
    validateSearch: (search: Record<string, unknown>) => ({
      ...(typeof search["scope"] === "string" && { scope: search["scope"] }),
      ...(typeof search["server"] === "string" && {
        server: search["server"],
      }),
    }),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$id",
    component: () => <div>investigation destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([auditRoute, sessionRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(
  actions: RemediationActionRecord[] = [],
  initialPath = "/audit",
) {
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

  renderAuditRoute(qc, initialPath);

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

    it("links each row to its originating investigation", async () => {
      setup([action({ sessionId: "sess-42" })]);

      const link = await screen.findByRole("link", {
        name: /open originating investigation/i,
      });
      expect(link).toHaveAttribute("href", "/sessions/sess-42");
    });
  });

  describe("scope filtering", () => {
    it("shows only matching rows for the URL scope", async () => {
      setup(
        [
          action({ toolUseId: "tu-exec", toolName: "RestartDockerService" }),
          action({
            toolUseId: "tu-rej",
            toolName: "K8sBash",
            status: "rejected",
          }),
        ],
        "/audit?scope=executed",
      );

      expect(
        await screen.findByText("RestartDockerService"),
      ).toBeInTheDocument();
      expect(screen.queryByText("K8sBash")).not.toBeInTheDocument();
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

      renderAuditRoute(qc, "/audit");

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
