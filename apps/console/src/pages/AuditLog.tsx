import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type { RemediationActionRecord } from "@nightwarden/shared";
import { ExternalLink, ScrollText } from "lucide-react";
import { matchesScope, type AuditScope } from "@/components/layout/AuditRail";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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

export function AuditLogPage(): React.JSX.Element {
  const search = useSearch({ strict: false }) as {
    scope?: AuditScope;
    server?: string;
  };
  const scope = search.scope ?? "all";
  const server = search.server ?? null;

  const {
    data: allActions,
    isLoading,
    isError,
  } = useQuery<RemediationActionRecord[]>({
    queryKey: ["remediation-actions"],
    queryFn: () =>
      apiFetch<RemediationActionRecord[]>("/api/remediation-actions"),
    refetchInterval: 30_000,
  });

  const actions = allActions?.filter(
    (a) =>
      matchesScope(a, scope) &&
      (server === null || a.serviceIdentityKey === server),
  );

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
                <TableHead className="sr-only">Investigation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SkeletonRows count={3} columns={7} />
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
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollText {...ICON_DISPLAY} />
            </EmptyMedia>
            <EmptyTitle>No remediation actions recorded yet</EmptyTitle>
            <EmptyDescription>
              When NightWarden executes, rejects, or fails a remediation action,
              it appears here so you can audit every decision the system made on
              your behalf.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
                <TableHead className="sr-only">Investigation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => {
                const statusView = statusVariant("remediation", action.status);
                return (
                  <TableRow key={`${action.sessionId}/${action.toolUseId}`}>
                    <TableCell className="font-mono tabular-nums">
                      <span
                        className="block max-w-60 truncate"
                        title={action.toolName}
                      >
                        {action.toolName}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      <span
                        className="block max-w-60 truncate"
                        title={action.serviceIdentityKey ?? "unknown service"}
                      >
                        {action.serviceIdentityKey ?? "unknown service"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusView.variant} dot>
                        {statusView.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span
                        className="block max-w-60 truncate"
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
                    <TableCell className="text-right">
                      {/* Audit rows outlive session deletion; the link simply
                          degrades when the transcript is gone. */}
                      <Link
                        to="/sessions/$id"
                        params={{ id: action.sessionId }}
                        aria-label="Open originating investigation"
                        className="inline-flex text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink {...ICON_DISPLAY} className="size-4" />
                      </Link>
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
