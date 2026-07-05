import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { AuthStatusResponse } from "@nightwatch/shared";

import { installFetchInterceptor } from "./fetchInterceptor.js";

export type AuthPhase =
  | { kind: "loading" }
  | { kind: "needs-setup" }
  | { kind: "needs-login" }
  | { kind: "authenticated"; email: string };

export type AuthActionResult = { ok: true } | { ok: false; error: string };

function phaseFromStatus(status: AuthStatusResponse): AuthPhase {
  if (!status.ownerExists) return { kind: "needs-setup" };
  if (!status.authenticated) return { kind: "needs-login" };
  return { kind: "authenticated", email: status.email };
}

async function postCredentials(
  path: string,
  email: string,
  password: string,
): Promise<AuthActionResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    // auth routes always reply { error: string } on a non-2xx response.
    const body = (await res.json()) as { error?: string };
    return { ok: false, error: body.error ?? "request failed" };
  }
  return { ok: true };
}

interface AuthContextValue {
  phase: AuthPhase;
  login: (email: string, password: string) => Promise<AuthActionResult>;
  signup: (email: string, password: string) => Promise<AuthActionResult>;
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
    fetch("/api/auth/status")
      .then((res) => {
        if (!res.ok) throw new Error(`auth status ${res.status}`);
        // The auth/status route is a project-controlled contract; its shape is
        // AuthStatusResponse on every 2xx reply.
        return res.json() as Promise<AuthStatusResponse>;
      })
      .then((data) => setPhase(phaseFromStatus(data)))
      // A failed/unreachable status check must not leave the app stuck on the
      // loading screen forever; fall back to the login page (reachable, and it
      // surfaces its own error if the API is genuinely down).
      .catch(() => setPhase({ kind: "needs-login" }));
  }, []);

  useEffect(
    () => installFetchInterceptor(() => setPhase({ kind: "needs-login" })),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const result = await postCredentials("/api/login", email, password);
    if (result.ok) setPhase({ kind: "authenticated", email });
    return result;
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const result = await postCredentials("/api/setup", email, password);
    if (result.ok) setPhase({ kind: "authenticated", email });
    return result;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" });
    setPhase({ kind: "needs-login" });
  }, []);

  const logoutAll = useCallback(async () => {
    await fetch("/api/logout-all", { method: "POST" });
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
