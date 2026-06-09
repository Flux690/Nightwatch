import { Outlet } from "@tanstack/react-router";
import { Button, Text } from "@mantine/core";

export function SessionsLayout(): React.JSX.Element {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside
        style={{
          width: 260,
          borderRight: "1px solid var(--mantine-color-dark-4)",
          padding: "var(--mantine-spacing-sm)",
        }}
      >
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="sm">
          Sessions
        </Text>
        <Button fullWidth size="xs" mb="sm">
          New Session
        </Button>
      </aside>
      <main style={{ flex: 1, overflow: "hidden" }}>
        <Outlet />
      </main>
    </div>
  );
}

export function SessionsEmpty(): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text c="dimmed" size="sm">
        Select a session or start a new one
      </Text>
    </div>
  );
}
