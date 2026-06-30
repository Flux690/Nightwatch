import { useQuery } from "@tanstack/react-query";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";
import { Badge } from "../ui/Badge.js";
import { Loader } from "../ui/Loader.js";
import { Stack } from "../ui/Stack.js";
import { Text } from "../ui/Text.js";
import { Title } from "../ui/Title.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

type AlertIntent = "error" | "warning" | "info";

const SEVERITY_INTENT: Record<UnresolvedAlertRecord["severity"], AlertIntent> =
  {
    critical: "error",
    warning: "warning",
    info: "info",
  };

export function UnresolvedAlertsPage(): React.JSX.Element {
  const {
    data: alerts,
    isLoading,
    isError,
  } = useQuery<UnresolvedAlertRecord[]>({
    queryKey: ["unresolved-alerts"],
    queryFn: () => apiFetch<UnresolvedAlertRecord[]>("/api/unresolved-alerts"),
    refetchInterval: 30_000,
  });

  return (
    <div className="page" style={{ padding: 16 }}>
      <Title order={2} className="text-lg mb-4">
        Unresolved alerts
      </Title>

      {isLoading && <Loader aria-label="Loading unresolved alerts" />}

      {isError && (
        <Text className="text-sm text-status-failed">
          Failed to load unresolved alerts.
        </Text>
      )}

      {!isLoading && !isError && alerts?.length === 0 && (
        <Text className="text-sm text-ink-muted">No unresolved alerts.</Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(alerts ?? []).map((alert, i) => (
          <li
            key={`${alert.sourceAlertId}-${i}`}
            style={{
              borderTop: "1px solid var(--color-line)",
              padding: "8px 0",
            }}
          >
            <Stack className="gap-0.5">
              <Text className="text-sm font-mono">{alert.alertType}</Text>
              <Text className="text-xs text-ink-muted font-mono">
                {alert.identityKey}
              </Text>
              <Badge intent={SEVERITY_INTENT[alert.severity]}>
                {alert.severity}
              </Badge>
              <Text className="text-xs text-ink-muted">
                {alert.rejectionReason}
              </Text>
              <Text className="text-xs text-ink-muted">
                {timeAgo(alert.createdAt)}
              </Text>
            </Stack>
          </li>
        ))}
      </ul>
    </div>
  );
}
