import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { AuthStatusResponse } from "@nightwarden/shared";

import { installFetchInterceptor } from "./fetchInterceptor.js";

type AuthPhase =
  | { kind: "loading" }
  | { kind: "needs-setup" }
  | { kind: "needs-login" }
  | { kind: "authenticated"; email: string; name: string };

export type AuthActionResult = { ok: true } | { ok: false; error: string };

function phaseFromStatus(status: AuthStatusResponse): AuthPhase {
  if (!status.ownerExists) return { kind: "needs-setup" };
  if (!status.authenticated) return { kind: "needs-login" };
  return { kind: "authenticated", email: status.email, name: status.name };
}

// Better Auth answers a failure with `message`, so the two shapes are both read
// rather than assuming either.
async function post(
  path: string,
  body: Record<string, string>,
): Promise<AuthActionResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  const failure = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  return {
    ok: false,
    error: failure.message ?? failure.error ?? "request failed",
  };
}

interface AuthContextValue {
  phase: AuthPhase;
  login: (email: string, password: string) => Promise<AuthActionResult>;
  signup: (
    name: string,
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/auth-status")
      .then((res) => {
        if (!res.ok) throw new Error(`auth status ${res.status}`);
        // A project-controlled contract: the shape is AuthStatusResponse on
        // every 2xx reply.
        return res.json() as Promise<AuthStatusResponse>;
      })
      .then((data) => setPhase(phaseFromStatus(data)))
      // Fall back to the login page on a failed status check, rather than
      // leaving the app on the loading screen forever.
      .catch(() => setPhase({ kind: "needs-login" }));
  }, []);

  useEffect(
    () => installFetchInterceptor(() => setPhase({ kind: "needs-login" })),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const result = await post("/api/auth/sign-in/email", { email, password });
    if (result.ok) setPhase({ kind: "authenticated", email, name: email });
    return result;
  }, []);

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      const result = await post("/api/auth/sign-up/email", {
        name,
        email,
        password,
      });
      if (result.ok) setPhase({ kind: "authenticated", email, name });
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    setPhase({ kind: "needs-login" });
  }, []);

  // Every device, this one included, so the page returns to the login screen.
  const logoutAll = useCallback(async () => {
    await fetch("/api/auth/revoke-sessions", { method: "POST" });
    await fetch("/api/auth/sign-out", { method: "POST" });
    setPhase({ kind: "needs-login" });
  }, []);

  return (
    <AuthContext.Provider value={{ phase, login, signup, logout, logoutAll }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
