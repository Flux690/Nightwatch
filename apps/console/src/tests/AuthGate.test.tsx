import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import { AuthProvider } from "@/auth/AuthContext";
import { AuthGate } from "../auth/AuthGate.js";
import { MockEventSource } from "./mockEventSource.js";

function makeRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => <div>LOGIN</div>,
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "app",
    component: AuthGate,
  });
  const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([
      loginRoute,
      appRoute.addChildren([indexRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function setup(statusResponse: object) {
  vi.stubGlobal("EventSource", MockEventSource);

  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(statusResponse),
      });
    }
    if (url.includes("/sessions/pending-human-input")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes("/sessions")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = makeRouter();

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("AuthGate", () => {
  it("renders the app shell and stays at / when authenticated", async () => {
    const { router } = setup({
      ownerExists: true,
      authenticated: true,
      email: "a@b.com",
    });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /integrations/i })).toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("navigates to /login when no owner account exists yet", async () => {
    const { router } = setup({ ownerExists: false });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(screen.getByText("LOGIN")).toBeInTheDocument();
  });

  it("navigates to /login when an owner exists but the session cookie is not authenticated", async () => {
    const { router } = setup({ ownerExists: true, authenticated: false });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(screen.getByText("LOGIN")).toBeInTheDocument();
  });

  it("shows a loader (not the shell or login) while the status fetch is pending", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const router = makeRouter();

    render(
      <TestProviders>
        <QueryClientProvider client={qc}>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryClientProvider>
      </TestProviders>,
    );

    // A spinner during the check, but never the protected shell or a login flash.
    expect(
      await screen.findByRole("status", { name: /checking sign-in/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("LOGIN")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /integrations/i }),
    ).not.toBeInTheDocument();
  });

  it("navigates to /login when a 401 arrives from any fetch mid-session", async () => {
    vi.stubGlobal("EventSource", MockEventSource);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/auth/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ownerExists: true,
              authenticated: true,
              email: "a@b.com",
            }),
        });
      }
      if (url.includes("/sessions/pending-human-input")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes("/sessions")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.endsWith("/trigger-401")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: "expired" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const router = makeRouter();

    render(
      <TestProviders>
        <QueryClientProvider client={qc}>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryClientProvider>
      </TestProviders>,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /integrations/i })).toBeInTheDocument();
    });

    await fetch("/trigger-401");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(screen.getByText("LOGIN")).toBeInTheDocument();
  });
});
