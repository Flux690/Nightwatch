import { useQuery } from "@tanstack/react-query";
import type { UnresolvedAlertRecord } from "@nightwatch/shared";
import { BellOff } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Page,
  PageHeader,
  PageTitle,
  PageTableWrap,
  TABLE_HEAD,
  SkeletonRows,
} from "@/components/layout/Page";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ICON_DISPLAY } from "@/lib/iconProps";
import { Badge } from "@/components/ui/badge";
import { statusVariant } from "@/lib/statusVariants";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { apiFetch } from "@/api/client";
import { timeAgo } from "@/lib/time";

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
    <Page>
      <PageHeader>
        <PageTitle>Unresolved alerts</PageTitle>
      </PageHeader>

      {isLoading && (
        <PageTableWrap role="status" aria-label="Loading unresolved alerts">
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <TableHead>Alert</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SkeletonRows count={3} columns={5} />
            </TableBody>
          </Table>
        </PageTableWrap>
      )}

      {isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Failed to load unresolved alerts</AlertTitle>
          <AlertDescription>
            Something went wrong loading unresolved alerts. It will retry
            automatically.
          </AlertDescription>
        </Alert>
      )}

      {isEmpty && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellOff {...ICON_DISPLAY} />
            </EmptyMedia>
            <EmptyTitle>No unresolved alerts</EmptyTitle>
            <EmptyDescription>
              When an incoming alert cannot be routed to a runner, it appears
              here with the rejection reason so you can diagnose fleet coverage
              gaps.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {!isLoading && !isError && alerts && alerts.length > 0 && (
        <PageTableWrap>
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <TableHead>Alert</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.map((alert, i) => {
                const severityView = statusVariant("alert", alert.severity);
                return (
                  <TableRow key={`${alert.sourceAlertId}-${i}`}>
                    <TableCell className="font-mono tabular-nums">
                      <span
                        className="block max-w-60 truncate"
                        title={alert.alertType}
                      >
                        {alert.alertType}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      <span
                        className="block max-w-60 truncate"
                        title={alert.identityKey}
                      >
                        {alert.identityKey}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={severityView.variant} dot>
                        {severityView.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span
                        className="block max-w-60 truncate"
                        title={alert.rejectionReason}
                      >
                        {alert.rejectionReason}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-right">
                      {timeAgo(alert.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </PageTableWrap>
      )}
    </Page>
  );
}
