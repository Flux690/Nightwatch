import { useQuery } from "@tanstack/react-query";
import type { RemediationActionRecord } from "@nightwatch/shared";
import { Loader } from "../ui/Loader.js";
import { Stack } from "../ui/Stack.js";
import { StatusChip } from "../ui/StatusChip.js";
import { Text } from "../ui/Text.js";
import { Title } from "../ui/Title.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

export function AuditLogPage(): React.JSX.Element {
  const {
    data: actions,
    isLoading,
    isError,
  } = useQuery<RemediationActionRecord[]>({
    queryKey: ["remediation-actions"],
    queryFn: () =>
      apiFetch<RemediationActionRecord[]>("/api/remediation-actions"),
    refetchInterval: 30_000,
  });

  return (
    <div className="page" style={{ padding: 16 }}>
      <Title order={2} className="text-lg mb-4">
        Audit log
      </Title>

      {isLoading && <Loader aria-label="Loading audit log" />}

      {isError && (
        <Text className="text-sm text-status-failed">
          Couldn&apos;t load the audit log. Retrying…
        </Text>
      )}

      {!isLoading && !isError && actions?.length === 0 && (
        <Text className="text-sm text-ink-muted">
          No remediation actions recorded yet.
        </Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(actions ?? []).map((action) => (
          <li
            key={`${action.sessionId}/${action.toolUseId}`}
            style={{
              borderTop: "1px solid var(--color-line)",
              padding: "8px 0",
            }}
          >
            <Stack className="gap-0.5">
              <Text className="text-sm font-mono">{action.toolName}</Text>
              <Text className="text-xs text-ink-muted font-mono">
                {action.serviceIdentityKey ?? "unknown service"}
              </Text>
              <StatusChip status={action.status} domain="remediation" />
              <Text className="text-xs text-ink-muted">
                {action.resolvedBy ?? "unknown"} · decided{" "}
                {timeAgo(action.createdAt)} ·{" "}
                {action.status === "executing"
                  ? "in progress"
                  : `resolved ${timeAgo(action.resolvedAt)}`}
              </Text>
            </Stack>
          </li>
        ))}
      </ul>
    </div>
  );
}
