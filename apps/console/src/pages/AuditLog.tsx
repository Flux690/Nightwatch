import { useQuery } from "@tanstack/react-query";
import type { RemediationActionRecord } from "@nightwatch/shared";
import { ScrollText } from "lucide-react";
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
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="font-mono tabular-nums text-right">
            <Skeleton className="ml-auto h-3.5 w-16" />
          </TableCell>
          <TableCell className="font-mono tabular-nums text-right">
            <Skeleton className="ml-auto h-3.5 w-16" />
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
    <Page>
      <PageHeader>
        <PageTitle>Audit log</PageTitle>
      </PageHeader>

      {isLoading && (
        <PageTableWrap role="status" aria-label="Loading audit log">
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Resolved</TableHead>
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
          <AlertTitle>Failed to load audit log</AlertTitle>
          <AlertDescription>
            Something went wrong loading the audit log. It will retry
            automatically.
          </AlertDescription>
        </Alert>
      )}

      {isEmpty && (
        <EmptyState>
          <ScrollText
            {...ICON_DISPLAY}
            className="mb-3 text-muted-foreground"
          />
          <h2 className="m-0 mb-1 text-base font-semibold text-foreground">
            No remediation actions recorded yet
          </h2>
          <p className="m-0 mb-4 text-sm text-muted-foreground">
            When Nightwatch executes, rejects, or fails a remediation action, it
            appears here so you can audit every decision the system made on your
            behalf.
          </p>
        </EmptyState>
      )}

      {!isLoading && !isError && actions && actions.length > 0 && (
        <PageTableWrap>
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Resolved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={`${action.sessionId}/${action.toolUseId}`}>
                  <TableCell className="font-mono tabular-nums">
                    <span
                      className="block max-w-[240px] truncate"
                      title={action.toolName}
                    >
                      {action.toolName}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    <span
                      className="block max-w-[240px] truncate"
                      title={action.serviceIdentityKey ?? "unknown service"}
                    >
                      {action.serviceIdentityKey ?? "unknown service"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={action.status} domain="remediation" />
                  </TableCell>
                  <TableCell>
                    <span
                      className="block max-w-[240px] truncate"
                      title={action.resolvedBy ?? "unknown"}
                    >
                      {action.resolvedBy ?? "unknown"}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-right">
                    {timeAgo(action.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-right">
                    {action.status === "executing"
                      ? "in progress"
                      : timeAgo(action.resolvedAt)}
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
