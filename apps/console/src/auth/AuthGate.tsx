import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useAuth } from "./AuthContext.js";
import { Shell } from "../pages/Shell.js";

export function AuthGate(): React.JSX.Element | null {
  const { phase } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (phase.kind === "needs-setup" || phase.kind === "needs-login") {
      void navigate({ to: "/login" });
    }
  }, [phase.kind, navigate]);

  if (phase.kind !== "authenticated") return null;
  return <Shell />;
}
