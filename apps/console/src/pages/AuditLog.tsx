import { useQuery } from "@tanstack/react-query";
import type { RemediationActionRecord } from "@nightwatch/shared";
import { ScrollText } from "lucide-react";
import { Alert } from "../ui/Alert.js";
import { ICON_DISPLAY } from "../ui/iconProps.js";
import { StatusChip } from "../ui/StatusChip.js";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from "../ui/Table.js";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

function SkeletonRows({ count }: { count: number }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          <TableCell data-mono>
            <span className="skeleton skeleton--text" />
          </TableCell>
          <TableCell data-mono>
            <span className="skeleton skeleton--text" />
          </TableCell>
          <TableCell>
            <span className="skeleton skeleton--chip" />
          </TableCell>
          <TableCell>
            <span className="skeleton skeleton--text-sm" />
          </TableCell>
          <TableCell data-mono data-align="right">
            <span className="skeleton skeleton--text-sm" />
          </TableCell>
          <TableCell data-mono data-align="right">
            <span className="skeleton skeleton--text-sm" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

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

  const isEmpty = !isLoading && !isError && actions?.length === 0;

  return (
    <div className="page page--data">
      <header className="page-header">
        <h1 className="page-title">Audit log</h1>
      </header>

      {isLoading && (
        <div
          className="page-table-wrap"
          role="status"
          aria-label="Loading audit log"
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Action</TableHeader>
                <TableHeader>Service</TableHeader>
                <TableHeader>Outcome</TableHeader>
                <TableHeader>Decided by</TableHeader>
                <TableHeader data-align="right">Created</TableHeader>
                <TableHeader data-align="right">Resolved</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              <SkeletonRows count={3} />
            </TableBody>
          </Table>
        </div>
      )}

      {isError && (
        <Alert
          intent="error"
          title="Failed to load audit log"
          className="page-alert"
        >
          Something went wrong loading the audit log. It will retry
          automatically.
        </Alert>
      )}

      {isEmpty && (
        <div className="empty-state">
          <div className="empty-state__content">
            <ScrollText {...ICON_DISPLAY} className="empty-state__icon" />
            <h2 className="empty-state__title">
              No remediation actions recorded yet
            </h2>
            <p className="empty-state__text">
              When Nightwatch executes, rejects, or fails a remediation action,
              it appears here so you can audit every decision the system made on
              your behalf.
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && actions && actions.length > 0 && (
        <div className="page-table-wrap">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Action</TableHeader>
                <TableHeader>Service</TableHeader>
                <TableHeader>Outcome</TableHeader>
                <TableHeader>Decided by</TableHeader>
                <TableHeader data-align="right">Created</TableHeader>
                <TableHeader data-align="right">Resolved</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={`${action.sessionId}/${action.toolUseId}`}>
                  <TableCell data-mono>
                    <span className="cell-truncate" title={action.toolName}>
                      {action.toolName}
                    </span>
                  </TableCell>
                  <TableCell data-mono>
                    <span
                      className="cell-truncate"
                      title={action.serviceIdentityKey ?? "unknown service"}
                    >
                      {action.serviceIdentityKey ?? "unknown service"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={action.status} domain="remediation" />
                  </TableCell>
                  <TableCell>
                    <span
                      className="cell-truncate"
                      title={action.resolvedBy ?? "unknown"}
                    >
                      {action.resolvedBy ?? "unknown"}
                    </span>
                  </TableCell>
                  <TableCell data-mono data-align="right">
                    {timeAgo(action.createdAt)}
                  </TableCell>
                  <TableCell data-mono data-align="right">
                    {action.status === "executing"
                      ? "in progress"
                      : timeAgo(action.resolvedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
