import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { AuthProvider, useAuth } from "../auth/AuthContext.js";
import type { AuthActionResult } from "../auth/AuthContext.js";

function Probe(): React.JSX.Element {
  const { phase, login, signup, logout, logoutAll } = useAuth();
  const [result, setResult] = useState<AuthActionResult | null>(null);

  return (
    <div>
      <div data-testid="phase">{phase.kind}</div>
      {result && (
        <div data-testid="result">{result.ok ? "ok" : result.error}</div>
      )}
      <button
        onClick={() =>
          void login("admin@example.com", "correcthorsebattery").then(setResult)
        }
      >
        login
      </button>
      <button
        onClick={() =>
          void signup("admin@example.com", "correcthorsebattery").then(
            setResult,
          )
        }
      >
        signup
      </button>
      <button onClick={() => void logout()}>logout</button>
      <button onClick={() => void logoutAll()}>logout-all</button>
    </div>
  );
}

function jsonResponse(status: number, body: object) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function stubStatus(response: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(jsonResponse(200, response)),
  );
}

// Routes by exact path suffix; falls back to the status response for the
// initial GET /api/auth/status bootstrap call every test triggers on mount.
function stubFetch(
  statusResponse: object,
  handlers: Record<string, ReturnType<typeof jsonResponse>>,
) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    for (const [path, response] of Object.entries(handlers)) {
      if (url.endsWith(path)) return Promise.resolve(response);
    }
    return Promise.resolve(jsonResponse(200, statusResponse));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuthProvider", () => {
  it("sets phase to needs-setup when GET /api/auth/status returns ownerExists: false", async () => {
    stubStatus({ ownerExists: false });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-setup");
    });
  });

  it("sets phase to needs-login when an owner exists but the cookie is not authenticated", async () => {
    stubStatus({ ownerExists: true, authenticated: false });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login");
    });
  });

  it("sets phase to authenticated with the owner's email for a valid cookie", async () => {
    stubStatus({
      ownerExists: true,
      authenticated: true,
      email: "admin@example.com",
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated");
    });
  });

  it("starts in the loading phase before the status fetch resolves, so nothing flashes", async () => {
    let resolveStatus!: (value: {
      ok: boolean;
      status: number;
      json: () => Promise<object>;
    }) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      ),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId("phase")).toHaveTextContent("loading");

    resolveStatus({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ownerExists: false }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-setup");
    });
  });
});

describe("AuthProvider actions", () => {
  it("login POSTs /api/login with the credentials and moves phase to authenticated", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { ownerExists: true, authenticated: false },
      { "/login": jsonResponse(200, { ok: true }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login"),
    );

    await user.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated");
    });
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

  it("login returns the server's error and stays on needs-login for invalid credentials", async () => {
    const user = userEvent.setup();
    stubFetch(
      { ownerExists: true, authenticated: false },
      { "/login": jsonResponse(401, { error: "invalid credentials" }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login"),
    );

    await user.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() => {
      expect(screen.getByTestId("result")).toHaveTextContent(
        "invalid credentials",
      );
    });
    expect(screen.getByTestId("phase")).toHaveTextContent("needs-login");
  });

  it("signup POSTs /api/setup and moves phase to authenticated", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { ownerExists: false },
      { "/setup": jsonResponse(200, { ok: true }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-setup"),
    );

    await user.click(screen.getByRole("button", { name: "signup" }));

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated");
    });
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

  it("logout POSTs /api/logout and moves phase back to needs-login", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { ownerExists: true, authenticated: true, email: "admin@example.com" },
      { "/logout": jsonResponse(200, { ok: true }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated"),
    );

    await user.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("logoutAll POSTs /api/logout-all and moves phase back to needs-login", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { ownerExists: true, authenticated: true, email: "admin@example.com" },
      { "/logout-all": jsonResponse(200, { ok: true }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated"),
    );

    await user.click(screen.getByRole("button", { name: "logout-all" }));

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/logout-all",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a 401 from any other fetch mid-session flips phase back to needs-login", async () => {
    stubFetch(
      { ownerExists: true, authenticated: true, email: "admin@example.com" },
      { "/sessions": jsonResponse(401, { error: "authentication required" }) },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("authenticated"),
    );

    await fetch("/api/sessions");

    await waitFor(() => {
      expect(screen.getByTestId("phase")).toHaveTextContent("needs-login");
    });
  });
});
