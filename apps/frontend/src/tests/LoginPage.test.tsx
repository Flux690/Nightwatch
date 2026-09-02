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

import { AuthProvider } from "@/features/auth/AuthContext";
import { LoginPage } from "../features/auth/LoginPage.js";

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
    if (url.endsWith("/auth-status")) {
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
  it("submits the sign-up endpoint with email and password (not confirmPassword) on valid setup", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByText(/create your account/i);

    await user.type(screen.getByLabelText(/your name/i), "Admin");
    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "correcthorsebattery",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/sign-up/email",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Admin",
            email: "admin@example.com",
            password: "correcthorsebattery",
          }),
        }),
      );
    });
  });

  it("submits the sign-in endpoint with email and password on valid login", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: true, authenticated: false });
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/sign-in/email",
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

  // With nothing wrong there is no live region in the tree at all, and an
  // error binds to the field that caused it.
  it("mounts no error region until there is an error, then binds it to its field", async () => {
    const user = userEvent.setup();
    setup({ ownerExists: false });
    await screen.findByText(/create your account/i);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const password = screen.getByLabelText(/^password/i);
    await user.type(password, "short");
    await user.tab();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/at least 12 characters/i);
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAttribute("aria-describedby", error.id);
  });

  it("shows the server's error message inline when login fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/auth-status")) {
        return Promise.resolve(
          jsonResponse(200, { ownerExists: true, authenticated: false }),
        );
      }
      // Better Auth answers a failure with `message`, which is what the page reads.
      if (url.endsWith("/sign-in/email")) {
        return Promise.resolve(
          jsonResponse(401, { message: "invalid credentials" }),
        );
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    setupWithMock(fetchMock);
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "wrongpassword123");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });
});
