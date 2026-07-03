import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { serviceIdentityKey, type RunnerRecord } from "@nightwatch/shared";
import { ChevronDown, ChevronUp, Network, Plus } from "lucide-react";
import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { Loader } from "../ui/Loader.js";
import { StatusChip } from "../ui/StatusChip.js";
import { Text } from "../ui/Text.js";
import { ICON_INLINE, ICON_DISPLAY } from "../ui/iconProps.js";
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
    <TableHeader
      data-align={align}
      aria-sort={
        active ? (activeDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button type="button" className="sort-btn" onClick={() => onSort(field)}>
        {label}
        {active && (
          <span className="sort-indicator" aria-hidden="true">
            {activeDir === "asc" ? (
              <ChevronUp size={12} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} strokeWidth={2} />
            )}
          </span>
        )}
      </button>
    </TableHeader>
  );
}

function SkeletonRows({ count }: { count: number }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          <TableCell>
            <span className="skeleton skeleton--text" />
          </TableCell>
          <TableCell>
            <span className="skeleton skeleton--chip" />
          </TableCell>
          <TableCell data-mono>
            <span className="skeleton skeleton--text-sm" />
          </TableCell>
          <TableCell data-mono data-align="right">
            <span className="skeleton skeleton--text-sm" />
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
    <div className="page page--data">
      <header className="page-header">
        <h1 className="page-title">Fleet</h1>
        {!isEmpty && (
          <Button
            size="sm"
            onClick={() => void navigate({ to: "/fleet/add" })}
            leftSection={<Plus {...ICON_INLINE} />}
          >
            Add a server
          </Button>
        )}
      </header>

      {removeError !== null && (
        <Alert intent="error" title="Remove failed" className="page-alert">
          {removeError}
        </Alert>
      )}

      {isLoading && (
        <div
          className="page-table-wrap"
          role="status"
          aria-label="Loading fleet"
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Server</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Services</TableHeader>
                <TableHeader data-align="right">Last seen</TableHeader>
                <TableHeader />
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
          title="Failed to load fleet"
          className="page-alert"
        >
          Something went wrong loading the fleet. It will retry automatically.
        </Alert>
      )}

      {isEmpty && (
        <div className="empty-state">
          <div className="empty-state__content">
            <Network {...ICON_DISPLAY} className="empty-state__icon" />
            <h2 className="empty-state__title">Your fleet is empty</h2>
            <p className="empty-state__text">
              Servers you add will appear here with their status, services, and
              last check-in time so you can monitor your infrastructure at a
              glance.
            </p>
            <Button
              onClick={() => void navigate({ to: "/fleet/add" })}
              leftSection={<Plus {...ICON_INLINE} />}
            >
              Add your first server
            </Button>
          </div>
        </div>
      )}

      {!isLoading && !isError && connectedRunners.length > 0 && (
        <div className="page-table-wrap">
          <Table>
            <TableHead>
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
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((runner) => {
                const status = runnerStatus(runner);
                const services = runner.manifest?.capabilities.services ?? [];
                const isOffline = !runner.online;
                return (
                  <TableRow
                    key={runner.token}
                    data-offline={isOffline || undefined}
                  >
                    <TableCell>
                      <span
                        className="cell-truncate"
                        title={runner.hostname ?? undefined}
                      >
                        {runner.hostname}
                      </span>
                      {services.length > 0 && (
                        <span
                          className="cell-services"
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
                      <StatusChip status={status} domain="runner" />
                    </TableCell>
                    <TableCell data-mono data-align="right">
                      {services.length}
                    </TableCell>
                    <TableCell data-mono data-align="right">
                      {timeAgo(runner.lastSeen)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="xs"
                        loading={removing === runner.token}
                        aria-label={`Remove server ${runner.hostname ?? runner.id}`}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          void handleRemove(runner.token);
                        }}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
