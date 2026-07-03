import { useQuery } from "@tanstack/react-query";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";
import { BellOff } from "lucide-react";
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
            <span className="skeleton skeleton--text" />
          </TableCell>
          <TableCell data-mono data-align="right">
            <span className="skeleton skeleton--text-sm" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

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

  const isEmpty = !isLoading && !isError && alerts?.length === 0;

  return (
    <div className="page page--data">
      <header className="page-header">
        <h1 className="page-title">Unresolved alerts</h1>
      </header>

      {isLoading && (
        <div
          className="page-table-wrap"
          role="status"
          aria-label="Loading unresolved alerts"
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Alert</TableHeader>
                <TableHeader>Identity</TableHeader>
                <TableHeader>Severity</TableHeader>
                <TableHeader>Reason</TableHeader>
                <TableHeader data-align="right">Received</TableHeader>
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
          title="Failed to load unresolved alerts"
          className="page-alert"
        >
          Something went wrong loading unresolved alerts. It will retry
          automatically.
        </Alert>
      )}

      {isEmpty && (
        <div className="empty-state">
          <div className="empty-state__content">
            <BellOff {...ICON_DISPLAY} className="empty-state__icon" />
            <h2 className="empty-state__title">No unresolved alerts</h2>
            <p className="empty-state__text">
              When an incoming alert cannot be routed to a runner, it appears
              here with the rejection reason so you can diagnose fleet coverage
              gaps.
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && alerts && alerts.length > 0 && (
        <div className="page-table-wrap">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Alert</TableHeader>
                <TableHeader>Identity</TableHeader>
                <TableHeader>Severity</TableHeader>
                <TableHeader>Reason</TableHeader>
                <TableHeader data-align="right">Received</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {alerts.map((alert, i) => (
                <TableRow key={`${alert.sourceAlertId}-${i}`}>
                  <TableCell data-mono>
                    <span className="cell-truncate" title={alert.alertType}>
                      {alert.alertType}
                    </span>
                  </TableCell>
                  <TableCell data-mono>
                    <span className="cell-truncate" title={alert.identityKey}>
                      {alert.identityKey}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={alert.severity} domain="alert" />
                  </TableCell>
                  <TableCell>
                    <span
                      className="cell-truncate"
                      title={alert.rejectionReason}
                    >
                      {alert.rejectionReason}
                    </span>
                  </TableCell>
                  <TableCell data-mono data-align="right">
                    {timeAgo(alert.createdAt)}
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
