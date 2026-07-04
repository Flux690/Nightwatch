import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { serviceIdentityKey, type RunnerRecord } from "@nightwatch/shared";
import { ChevronDown, ChevronUp, Network, Plus } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Page,
  PageHeader,
  PageTitle,
  PageTableWrap,
} from "@/components/layout/Page";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { statusVariant } from "@/lib/statusVariants";
import { ICON_INLINE, ICON_DISPLAY } from "@/lib/iconProps";
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

type RunnerStatus = "online" | "offline";

function runnerStatus(runner: RunnerRecord): RunnerStatus {
  return runner.online ? "online" : "offline";
}

type SortField = "hostname" | "status" | "lastSeen" | "services";
type SortDir = "asc" | "desc";

function compareRunners(
  a: RunnerRecord,
  b: RunnerRecord,
  field: SortField,
  dir: SortDir,
): number {
  let cmp = 0;
  switch (field) {
    case "hostname":
      cmp = (a.hostname ?? "").localeCompare(b.hostname ?? "");
      break;
    case "status": {
      const aOnline = a.online ? 1 : 0;
      const bOnline = b.online ? 1 : 0;
      cmp = aOnline - bOnline;
      break;
    }
    case "lastSeen": {
      const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
      const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
      cmp = aTime - bTime;
      break;
    }
    case "services": {
      const aCount = a.manifest?.capabilities.services.length ?? 0;
      const bCount = b.manifest?.capabilities.services.length ?? 0;
      cmp = aCount - bCount;
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
}

function SortableHeader({
  label,
  field,
  activeField,
  activeDir,
  onSort,
  align,
}: {
  label: string;
  field: SortField;
  activeField: SortField;
  activeDir: SortDir;
  onSort: (field: SortField) => void;
  align?: "right";
}): React.JSX.Element {
  const active = field === activeField;
  return (
    <TableHead
      className={align === "right" ? "text-right" : undefined}
      aria-sort={
        active ? (activeDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm border-0 bg-none p-0 font-[inherit] text-[inherit] tracking-[inherit] hover:text-foreground"
        onClick={() => onSort(field)}
      >
        {label}
        {active && (
          <span className="text-xs" aria-hidden="true">
            {activeDir === "asc" ? (
              <ChevronUp size={12} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} strokeWidth={2} />
            )}
          </span>
        )}
      </button>
    </TableHead>
  );
}

function SkeletonRows({ count }: { count: number }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          <TableCell>
            <Skeleton className="h-3.5 w-[120px]" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-[18px] w-20 rounded-full" />
          </TableCell>
          <TableCell className="font-mono tabular-nums">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="font-mono tabular-nums text-right">
            <Skeleton className="ml-auto h-3.5 w-16" />
          </TableCell>
          <TableCell />
        </TableRow>
      ))}
    </>
  );
}

export function FleetPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("hostname");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const {
    data: runners,
    isLoading,
    isError,
  } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    refetchInterval: 30_000,
  });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);
  const sorted = [...connectedRunners].sort((a, b) =>
    compareRunners(a, b, sortField, sortDir),
  );

  function handleSort(field: SortField): void {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  async function handleRemove(token: string): Promise<void> {
    setRemoving(token);
    setRemoveError(null);
    try {
      await apiFetch<void>(`/api/tokens/${token}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : "Failed to remove server",
      );
    } finally {
      setRemoving(null);
    }
  }

  const isEmpty = !isLoading && !isError && connectedRunners.length === 0;

  return (
    <Page>
      <PageHeader>
        <PageTitle>Fleet</PageTitle>
        {!isEmpty && (
          <Button size="sm" onClick={() => void navigate({ to: "/fleet/add" })}>
            <Plus {...ICON_INLINE} />
            Add a server
          </Button>
        )}
      </PageHeader>

      {removeError !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Remove failed</AlertTitle>
          <AlertDescription>{removeError}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <PageTableWrap role="status" aria-label="Loading fleet">
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <TableHead>Server</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Services</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
                <TableHead />
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
          <AlertTitle>Failed to load fleet</AlertTitle>
          <AlertDescription>
            Something went wrong loading the fleet. It will retry automatically.
          </AlertDescription>
        </Alert>
      )}

      {isEmpty && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Network {...ICON_DISPLAY} />
            </EmptyMedia>
            <EmptyTitle>Your fleet is empty</EmptyTitle>
            <EmptyDescription>
              Servers you add will appear here with their status, services, and
              last check-in time so you can monitor your infrastructure at a
              glance.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void navigate({ to: "/fleet/add" })}>
              <Plus {...ICON_INLINE} />
              Add your first server
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {!isLoading && !isError && connectedRunners.length > 0 && (
        <PageTableWrap>
          <Table className={TABLE_HEAD}>
            <TableHeader>
              <TableRow>
                <SortableHeader
                  label="Server"
                  field="hostname"
                  activeField={sortField}
                  activeDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="Status"
                  field="status"
                  activeField={sortField}
                  activeDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="Services"
                  field="services"
                  activeField={sortField}
                  activeDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="Last seen"
                  field="lastSeen"
                  activeField={sortField}
                  activeDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((runner) => {
                const status = runnerStatus(runner);
                const statusView = statusVariant("runner", status);
                const services = runner.manifest?.capabilities.services ?? [];
                const isOffline = !runner.online;
                return (
                  <TableRow
                    key={runner.token}
                    data-offline={isOffline || undefined}
                    className={cn(isOffline && "opacity-60")}
                  >
                    <TableCell>
                      <span
                        className="block max-w-[240px] truncate"
                        title={runner.hostname ?? undefined}
                      >
                        {runner.hostname}
                      </span>
                      {services.length > 0 && (
                        <span
                          className="mt-0.5 block max-w-[240px] truncate font-mono text-xs text-muted-foreground"
                          title={services
                            .map((s) => serviceIdentityKey(s.identity))
                            .join(", ")}
                        >
                          {services
                            .map((s) => serviceIdentityKey(s.identity))
                            .join(", ")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusView.variant} dot>
                        {statusView.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-right">
                      {services.length}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-right">
                      {timeAgo(runner.lastSeen)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={removing === runner.token}
                        aria-label={`Remove server ${runner.hostname ?? runner.id}`}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          void handleRemove(runner.token);
                        }}
                      >
                        {removing === runner.token && (
                          <Spinner className="size-3" />
                        )}
                        Remove
                      </Button>
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
