import { useState } from "react";
import { Button, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { serviceIdentityKey, type RunnerRecord } from "@nightwatch/shared";
import { StatusBadge } from "../components/StatusBadge.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";
import { AddServerWizard } from "./AddServerWizard.js";

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

export function FleetPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data: runners,
    isLoading,
    isError,
  } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    refetchInterval: 30_000,
  });

  function handleWizardClose(): void {
    setWizardOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["runners"] });
  }

  async function handleRemove(token: string): Promise<void> {
    setRemoving(token);
    setError(null);
    try {
      await apiFetch<void>(`/api/tokens/${token}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove server");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} size="h4">
          Fleet
        </Title>
        <Button size="xs" onClick={() => setWizardOpen(true)}>
          Add a server
        </Button>
      </Group>

      {error !== null && (
        <Text size="sm" c="red" mb="sm">
          {error}
        </Text>
      )}

      {isLoading && <Loader size="sm" aria-label="Loading fleet" />}

      {isError && (
        <Text size="sm" c="red">
          Couldn&apos;t load the fleet. Retrying…
        </Text>
      )}

      {!isLoading && !isError && runners?.length === 0 && (
        <Text size="sm" c="dimmed">
          No runners connected.
        </Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(runners ?? []).map((runner) => {
          const status = runnerStatus(runner);
          const services = runner.manifest?.capabilities.services ?? [];
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
                  <StatusBadge label={status} color={STATUS_COLOR[status]} />
                  {runner.lastSeen !== null && (
                    <Text size="xs" c="dimmed" ff="monospace">
                      {timeAgo(runner.lastSeen)}
                    </Text>
                  )}
                  {services.map((service) => (
                    <Text
                      key={serviceIdentityKey(service.identity)}
                      size="xs"
                      c="dimmed"
                      ff="monospace"
                    >
                      {serviceIdentityKey(service.identity)}
                    </Text>
                  ))}
                </Stack>
                <Button
                  size="xs"
                  color="red"
                  variant="subtle"
                  loading={removing === runner.token}
                  aria-label={`Remove server ${runner.hostname ?? runner.id}`}
                  onClick={() => void handleRemove(runner.token)}
                >
                  Remove
                </Button>
              </Group>
            </li>
          );
        })}
      </ul>

      <AddServerWizard opened={wizardOpen} onClose={handleWizardClose} />
    </div>
  );
}
