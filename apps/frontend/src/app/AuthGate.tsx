import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";

import { Spinner } from "@/shared/ui/spinner";
import { useAuth } from "@/features/auth/AuthContext.js";
import { FrontendEventsProvider } from "@/shared/events/FrontendEventsProvider";
import { Shell } from "@/app/Shell";

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
    <FrontendEventsProvider>
      <Shell>
        <Outlet />
      </Shell>
    </FrontendEventsProvider>
  );
}
