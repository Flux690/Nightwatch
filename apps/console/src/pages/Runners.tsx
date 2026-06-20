import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunnerRecord } from "@nightwatch/shared";
import { timeAgo } from "../utils/time.js";

type RunnerStatus = "awaiting connection" | "online" | "offline";

function runnerStatus(runner: RunnerRecord): RunnerStatus {
  if (runner.hostname === null) return "awaiting connection";
  if (runner.online) return "online";
  return "offline";
}

const STATUS_COLOR: Record<RunnerStatus, string> = {
  "awaiting connection": "var(--nw-status-awaiting)",
  online: "var(--nw-status-streaming)",
  offline: "var(--nw-status-offline)",
};

function StatusBadge({ status }: { status: RunnerStatus }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--nw-mono)",
        color: STATUS_COLOR[status],
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {status}
    </span>
  );
}

export function RunnersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
    refetchInterval: 30_000,
  });

  async function handleAddServer(): Promise<void> {
    setAdding(true);
    setError(null);
    setScript(null);
    try {
      const tokenRes = await fetch("/api/tokens", { method: "POST" });
      if (!tokenRes.ok) throw new Error(`tokens ${tokenRes.status}`);
      // Response shape guaranteed by POST /api/tokens contract
      const { token: plaintext } = (await tokenRes.json()) as { token: string };

      const scriptRes = await fetch(
        `/api/connect.sh?token=${encodeURIComponent(plaintext)}`,
      );
      if (!scriptRes.ok) throw new Error(`connect.sh ${scriptRes.status}`);
      const scriptText = await scriptRes.text();

      setScript(scriptText);
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add server");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(tokenId: string): Promise<void> {
    setRemoving(tokenId);
    setError(null);
    try {
      const res = await fetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove server");
    } finally {
      setRemoving(null);
    }
  }

  function copyScript(): void {
    if (script !== null) void navigator.clipboard.writeText(script);
  }

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} size="h4">
          Runners
        </Title>
        <Button
          size="xs"
          loading={adding}
          onClick={() => void handleAddServer()}
        >
          Add a server
        </Button>
      </Group>

      {error !== null && (
        <Text size="sm" c="red" mb="sm">
          {error}
        </Text>
      )}

      {script !== null && (
        <Alert
          color="yellow"
          title="You won't see this again — if lost, remove and re-add"
          withCloseButton
          onClose={() => setScript(null)}
          mb="md"
        >
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <Code
              block
              style={{
                flex: 1,
                fontFamily: "var(--nw-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {script}
            </Code>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Copy connect.sh script"
              onClick={copyScript}
            >
              ⧉
            </ActionIcon>
          </Group>
        </Alert>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(runners ?? []).map((runner) => {
          const status = runnerStatus(runner);
          const shortId = runner.id.slice(0, 8);
          return (
            <li
              key={runner.token}
              style={{
                borderTop: "1px solid var(--nw-border)",
                padding: "var(--mantine-spacing-sm) 0",
              }}
            >
              <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                  {runner.hostname !== null && (
                    <Text size="sm" ff="monospace">
                      {runner.hostname}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed" ff="monospace">
                    {shortId}…
                  </Text>
                  <StatusBadge status={status} />
                  {runner.lastSeen !== null && (
                    <Text size="xs" c="dimmed" ff="monospace">
                      {timeAgo(runner.lastSeen)}
                    </Text>
                  )}
                </Stack>
                <Button
                  size="xs"
                  color="red"
                  variant="subtle"
                  loading={removing === runner.token}
                  aria-label={`Remove server ${runner.hostname ?? shortId}`}
                  onClick={() => void handleRemove(runner.token)}
                >
                  Remove
                </Button>
              </Group>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
