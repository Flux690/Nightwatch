import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { AuthProvider } from "../auth/AuthContext.js";
import { LoginPage } from "../pages/LoginPage.js";
import { theme, cssVariablesResolver } from "../theme.js";

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
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <AuthProvider>
        <RouterProvider router={buildRouter()} />
      </AuthProvider>
    </MantineProvider>,
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
  it("shows the setup form with email, password, and confirm password fields when no owner exists", async () => {
    setup({ ownerExists: false });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /create your account/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it("shows the login form with email and password but no confirm field when an owner exists", async () => {
    setup({ ownerExists: true, authenticated: false });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^log in$/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/confirm password/i),
    ).not.toBeInTheDocument();
  });

  it("does not flag confirm password as mismatched when tabbed through while still empty", async () => {
    const user = userEvent.setup();
    setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.tab();
    await user.tab();

    expect(screen.queryByText(/do not match/i)).not.toBeInTheDocument();
  });

  it("flags a password under 12 characters as soon as the field loses focus, with no submit and no round-trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

    await user.type(screen.getByLabelText(/^password/i), "tooshort");
    await user.tab();

    expect(
      await screen.findByText(/at least 12 characters/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/setup", expect.anything());
    expect(
      screen.queryByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("flags a confirm-password mismatch as soon as the field loses focus, with no submit and no round-trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "correcthorsebatteryx",
    );
    await user.tab();

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/setup", expect.anything());
  });

  it("rejects a password under 12 characters inline with no round-trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "tooshort");
    await user.type(screen.getByLabelText(/confirm password/i), "tooshort");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/at least 12 characters/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/setup", expect.anything());
  });

  it("rejects a confirm-password mismatch inline with no round-trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "correcthorsebattery");
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "correcthorsebatteryx",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/setup", expect.anything());
  });

  it("submits /api/setup with email and password (not confirmPassword) on valid setup", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ ownerExists: false });
    await screen.findByRole("heading", { name: /create your account/i });

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
    await screen.findByRole("heading", { name: /^log in$/i });

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
    await screen.findByRole("heading", { name: /^log in$/i });

    await user.type(screen.getByLabelText(/^email/i), "admin@example.com");
    await user.type(screen.getByLabelText(/^password/i), "wrongpassword123");
    await user.click(screen.getByRole("button", { name: /^log in$/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });
});
