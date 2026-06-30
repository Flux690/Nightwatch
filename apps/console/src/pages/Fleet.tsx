import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { serviceIdentityKey, type RunnerRecord } from "@nightwatch/shared";
import { Button } from "../ui/Button.js";
import { Group } from "../ui/Group.js";
import { Loader } from "../ui/Loader.js";
import { Stack } from "../ui/Stack.js";
import { StatusChip } from "../ui/StatusChip.js";
import { Text } from "../ui/Text.js";
import { Title } from "../ui/Title.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";
import { AddServerWizard } from "./AddServerWizard.js";

type RunnerStatus = "online" | "offline";

function runnerStatus(runner: RunnerRecord): RunnerStatus {
  return runner.online ? "online" : "offline";
}

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
    refetchInterval: wizardOpen ? false : 30_000,
  });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);

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
    <div className="page" style={{ padding: 16 }}>
      <Group className="justify-between items-center mb-4">
        <Title order={2} className="text-lg">
          Fleet
        </Title>
        <Button size="xs" onClick={() => setWizardOpen(true)}>
          Add a server
        </Button>
      </Group>

      {error !== null && (
        <Text className="text-sm text-status-failed mb-3">{error}</Text>
      )}

      {isLoading && <Loader aria-label="Loading fleet" />}

      {isError && (
        <Text className="text-sm text-status-failed">
          Couldn&apos;t load the fleet. Retrying…
        </Text>
      )}

      {!isLoading && !isError && connectedRunners.length === 0 && (
        <Text className="text-sm text-ink-muted">No runners connected.</Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {connectedRunners.map((runner) => {
          const status = runnerStatus(runner);
          const services = runner.manifest?.capabilities.services ?? [];
          return (
            <li
              key={runner.token}
              style={{
                borderTop: "1px solid var(--color-line)",
                padding: "8px 0",
              }}
            >
              <Group className="justify-between items-start">
                <Stack className="gap-0.5">
                  {runner.hostname !== null && (
                    <Text className="text-sm font-mono">{runner.hostname}</Text>
                  )}
                  <StatusChip status={status} domain="runner" />
                  {runner.lastSeen !== null && (
                    <Text className="text-xs text-ink-muted font-mono">
                      {timeAgo(runner.lastSeen)}
                    </Text>
                  )}
                  {services.map((service) => (
                    <Text
                      key={serviceIdentityKey(service.identity)}
                      className="text-xs text-ink-muted font-mono"
                    >
                      {serviceIdentityKey(service.identity)}
                    </Text>
                  ))}
                </Stack>
                <Button
                  variant="ghost"
                  size="xs"
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
