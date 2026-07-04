import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { AuthProvider } from "@/auth/AuthContext";
import { LoginPage } from "../pages/LoginPage.js";

function jsonResponse(status: number, body: object) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function buildRouter() {
  const rootRoute = createRootRoute();
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginPage,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([loginRoute, homeRoute]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
}

function setupWithMock(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <TestProviders>
      <AuthProvider>
        <RouterProvider router={buildRouter()} />
      </AuthProvider>
    </TestProviders>,
  );
  return { fetchMock };
}

function setup(statusResponse: object) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/auth/status")) {
      return Promise.resolve(jsonResponse(200, statusResponse));
    }
    return Promise.resolve(jsonResponse(200, { ok: true }));
  });
  return setupWithMock(fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginPage", () => {
  it("submits /api/setup with email and password (not confirmPassword) on valid setup", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByText(/create your account/i);

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "correcthorsebattery",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/setup",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "admin@example.com",
            password: "correcthorsebattery",
          }),
        }),
      );
    });
  });

  it("submits /api/login with email and password on valid login", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: true, authenticated: false });
    await screen.findByText(/^log in$/i, { selector: "legend" });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "admin@example.com",
            password: "correcthorsebattery",
          }),
        }),
      );
    });
  });

  it("shows the server's error message inline when login fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/auth/status")) {
        return Promise.resolve(
          jsonResponse(200, { ownerExists: true, authenticated: false }),
        );
      }
      if (url.endsWith("/login")) {
        return Promise.resolve(
          jsonResponse(401, { error: "invalid credentials" }),
        );
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    setupWithMock(fetchMock);
    await screen.findByText(/^log in$/i, { selector: "legend" });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "wrongpassword123");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });
});
