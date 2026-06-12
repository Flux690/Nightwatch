import { Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";
import { timeAgo } from "../time.js";

function OnlineBadge({ online }: { online: boolean }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--nw-mono)",
        color: online
          ? "var(--nw-status-streaming)"
          : "var(--nw-status-offline)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {online ? "online" : "offline"}
    </span>
  );
}

export function RunnersPage(): React.JSX.Element {
  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
    // Fleet status has no WS invalidation; poll on a fixed cadence.
    refetchInterval: 30_000,
  });

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Runners
      </Title>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(runners ?? []).map((runner) => (
          <li
            key={runner.id}
            style={{
              borderTop: "1px solid var(--nw-border)",
              padding: "var(--mantine-spacing-sm) 0",
            }}
          >
            <Text size="sm" ff="monospace">
              {runner.hostname}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {runner.id.slice(0, 8)}…
            </Text>
            <OnlineBadge online={runner.online} />
            <Text size="xs" c="dimmed" ff="monospace">
              {timeAgo(runner.lastSeen)}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}
