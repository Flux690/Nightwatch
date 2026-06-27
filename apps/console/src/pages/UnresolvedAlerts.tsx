import { Badge, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

const SEVERITY_COLOR: Record<UnresolvedAlertRecord["severity"], string> = {
  critical: "red",
  warning: "orange",
  info: "blue",
};

export function UnresolvedAlertsPage(): React.JSX.Element {
  const { data: alerts, isError } = useQuery<UnresolvedAlertRecord[]>({
    queryKey: ["unresolved-alerts"],
    queryFn: () => apiFetch<UnresolvedAlertRecord[]>("/api/unresolved-alerts"),
    refetchInterval: 30_000,
  });

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Unresolved alerts
      </Title>

      {isError && (
        <Text size="sm" c="red">
          Failed to load unresolved alerts.
        </Text>
      )}

      {!isError && alerts !== undefined && alerts.length === 0 && (
        <Text size="sm" c="dimmed">
          No unresolved alerts.
        </Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(alerts ?? []).map((alert, i) => (
          <li
            key={`${alert.sourceAlertId}-${i}`}
            style={{
              borderTop: "1px solid var(--nw-border)",
              padding: "var(--mantine-spacing-sm) 0",
            }}
          >
            <Stack gap={2}>
              <Text size="sm" ff="monospace">
                {alert.alertType}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {alert.identityKey}
              </Text>
              <Badge
                size="sm"
                variant="light"
                color={SEVERITY_COLOR[alert.severity]}
              >
                {alert.severity}
              </Badge>
              <Text size="xs" c="dimmed">
                {alert.rejectionReason}
              </Text>
              <Text size="xs" c="dimmed">
                {timeAgo(alert.createdAt)}
              </Text>
            </Stack>
          </li>
        ))}
      </ul>
    </div>
  );
}
