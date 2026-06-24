import { Group, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { serviceIdentityKey, type FleetRunner } from "@nightwatch/shared";
import { StatusBadge } from "../components/StatusBadge.js";

const STATUS_COLOR = {
  online: "var(--nw-status-streaming)",
  offline: "var(--nw-status-offline)",
} as const;

export function FleetPage(): React.JSX.Element {
  const { data: fleet } = useQuery<FleetRunner[]>({
    queryKey: ["fleet"],
    queryFn: () =>
      fetch("/api/fleet").then((r) => {
        if (!r.ok) throw new Error(`fleet ${r.status}`);
        return r.json() as Promise<FleetRunner[]>;
      }),
    refetchInterval: 30_000,
  });

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Fleet
      </Title>

      {fleet !== undefined && fleet.length === 0 && (
        <Text size="sm" c="dimmed">
          No runners connected.
        </Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(fleet ?? []).map((runner) => (
          <li
            key={runner.runnerId}
            style={{
              borderTop: "1px solid var(--nw-border)",
              padding: "var(--mantine-spacing-sm) 0",
            }}
          >
            <Stack gap={2}>
              <Group gap="xs" align="center">
                <Text size="sm" ff="monospace">
                  {runner.hostname}
                </Text>
                <StatusBadge
                  label={runner.online ? "online" : "offline"}
                  color={STATUS_COLOR[runner.online ? "online" : "offline"]}
                />
              </Group>
              {runner.services.map((service) => (
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
          </li>
        ))}
      </ul>
    </div>
  );
}
