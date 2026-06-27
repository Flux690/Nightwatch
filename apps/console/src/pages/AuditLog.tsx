import { Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { RemediationActionRecord } from "@nightwatch/shared";
import { StatusBadge } from "../components/StatusBadge.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

const OUTCOME_COLOR: Record<RemediationActionRecord["status"], string> = {
  executing: "var(--nw-status-awaiting)",
  executed: "var(--nw-status-streaming)",
  failed: "var(--nw-status-escalated)",
  rejected: "var(--nw-status-offline)",
};

export function AuditLogPage(): React.JSX.Element {
  const { data: actions } = useQuery<RemediationActionRecord[]>({
    queryKey: ["remediation-actions"],
    queryFn: () =>
      apiFetch<RemediationActionRecord[]>("/api/remediation-actions"),
    refetchInterval: 30_000,
  });

  return (
    <div className="nw-page" style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Audit log
      </Title>

      {actions !== undefined && actions.length === 0 && (
        <Text size="sm" c="dimmed">
          No remediation actions recorded yet.
        </Text>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(actions ?? []).map((action) => (
          <li
            key={`${action.sessionId}/${action.toolUseId}`}
            style={{
              borderTop: "1px solid var(--nw-border)",
              padding: "var(--mantine-spacing-sm) 0",
            }}
          >
            <Stack gap={2}>
              <Text size="sm" ff="monospace">
                {action.toolName}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {action.serviceIdentityKey ?? "unknown service"}
              </Text>
              <StatusBadge
                label={action.status}
                color={OUTCOME_COLOR[action.status]}
              />
              <Text size="xs" c="dimmed">
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
