import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Center } from "../ui/Center.js";
import { Loader } from "../ui/Loader.js";
import { useAuth } from "./AuthContext.js";
import { ConsoleWsProvider } from "../hooks/ConsoleWsProvider.js";
import { Shell } from "../pages/Shell.js";

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
      <Center className="h-screen" role="status" aria-label="Checking sign-in">
        <Loader />
      </Center>
    );
  }
  if (phase.kind !== "authenticated") return null;
  return (
    <ConsoleWsProvider>
      <Shell />
    </ConsoleWsProvider>
  );
}
