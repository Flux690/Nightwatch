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
  EmptyState,
} from "@/components/layout/Page";
import { ICON_DISPLAY } from "@/lib/iconProps";
import { StatusBadge } from "@/components/StatusBadge";
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

// Warm Steel column headers: small, muted, upper-case across every data table.
const TABLE_HEAD =
  "[&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:uppercase [&_thead_th]:tracking-wider [&_thead_th]:text-muted-foreground";

function SkeletonRows({ count }: { count: number }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          <TableCell className="font-mono tabular-nums">
            <Skeleton className="h-3.5 w-[120px]" />
          </TableCell>
          <TableCell className="font-mono tabular-nums">
            <Skeleton className="h-3.5 w-[120px]" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-[18px] w-20 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-3.5 w-[120px]" />
          </TableCell>
          <TableCell className="font-mono tabular-nums text-right">
            <Skeleton className="ml-auto h-3.5 w-16" />
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
              <SkeletonRows count={3} />
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
        <EmptyState>
          <BellOff {...ICON_DISPLAY} className="mb-3 text-muted-foreground" />
          <h2 className="m-0 mb-1 text-base font-semibold text-foreground">
            No unresolved alerts
          </h2>
          <p className="m-0 mb-4 text-sm text-muted-foreground">
            When an incoming alert cannot be routed to a runner, it appears here
            with the rejection reason so you can diagnose fleet coverage gaps.
          </p>
        </EmptyState>
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
              {alerts.map((alert, i) => (
                <TableRow key={`${alert.sourceAlertId}-${i}`}>
                  <TableCell className="font-mono tabular-nums">
                    <span
                      className="block max-w-[240px] truncate"
                      title={alert.alertType}
                    >
                      {alert.alertType}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    <span
                      className="block max-w-[240px] truncate"
                      title={alert.identityKey}
                    >
                      {alert.identityKey}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={alert.severity} domain="alert" />
                  </TableCell>
                  <TableCell>
                    <span
                      className="block max-w-[240px] truncate"
                      title={alert.rejectionReason}
                    >
                      {alert.rejectionReason}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-right">
                    {timeAgo(alert.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PageTableWrap>
      )}
    </Page>
  );
}
