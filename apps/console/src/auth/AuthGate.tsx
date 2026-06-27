import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Center, Loader } from "@mantine/core";

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

  // The initial status check can take a moment on a cold server; show a spinner
  // rather than a blank screen, but never the protected Shell before auth.
  if (phase.kind === "loading") {
    return (
      <Center h="100vh" role="status" aria-label="Checking sign-in">
        <Loader />
      </Center>
    );
  }
  if (phase.kind !== "authenticated") return null;
  return <Shell />;
}
