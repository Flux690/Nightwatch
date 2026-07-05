import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";

import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "./AuthContext.js";
import { ConsoleWsProvider } from "@/hooks/ConsoleWsProvider";
import { Shell } from "@/components/layout/Shell";

export function AuthGate(): React.JSX.Element | null {
  const { phase } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (phase.kind === "needs-setup" || phase.kind === "needs-login") {
      void navigate({ to: "/login" });
    }
  }, [phase.kind, navigate]);

  if (phase.kind === "loading") {
    return (
      <div
        className="flex h-screen items-center justify-center"
        role="status"
        aria-label="Checking sign-in"
      >
        <Spinner />
      </div>
    );
  }
  if (phase.kind !== "authenticated") return null;
  return (
    <ConsoleWsProvider>
      <Shell>
        <Outlet />
      </Shell>
    </ConsoleWsProvider>
  );
}
