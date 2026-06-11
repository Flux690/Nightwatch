import { AppShell, Text } from "@mantine/core";
import {
  Link,
  Outlet,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { SessionsSidebar } from "./Sessions.js";
import { SessionView } from "./SessionTranscript.js";

function NavLink({
  to,
  label,
}: {
  to: string;
  label: string;
}): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Link
      to={to}
      style={{
        display: "block",
        padding: "6px var(--mantine-spacing-xs)",
        borderRadius: "var(--mantine-radius-sm)",
        color: active ? "var(--nw-accent)" : "var(--nw-text-muted)",
        background: active ? "var(--nw-surface-raised)" : "transparent",
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}

export function Shell(): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };

  const isSessionArea = pathname === "/" || pathname.startsWith("/sessions/");

  return (
    <AppShell
      navbar={{ width: 260, breakpoint: 0 }}
      padding={0}
      styles={{ main: { background: "var(--nw-bg)" } }}
    >
      <AppShell.Navbar
        style={{
          background: "var(--nw-surface)",
          borderRight: "1px solid var(--nw-border)",
          display: "flex",
          flexDirection: "column",
          padding: "var(--mantine-spacing-sm)",
          gap: 2,
        }}
      >
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: "0.06em", paddingBottom: 4 }}
        >
          Nightwatch
        </Text>

        <NavLink to="/" label="Sessions" />
        <NavLink to="/runners" label="Runners" />
        <NavLink to="/settings" label="Settings" />

        <div
          style={{
            borderTop: "1px solid var(--nw-border)",
            marginTop: "var(--mantine-spacing-xs)",
            paddingTop: "var(--mantine-spacing-xs)",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {isSessionArea && <SessionsSidebar />}
        </div>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
        }}
      >
        {isSessionArea ? (
          <SessionView sessionId={params.id ?? null} />
        ) : (
          <Outlet />
        )}
      </AppShell.Main>
    </AppShell>
  );
}
