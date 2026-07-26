import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwarden/shared";
import { Plus } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ServerCard, serverDisplayName } from "@/components/layout/ServerCard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { ICON_INLINE } from "@/lib/iconProps";
import { apiFetch } from "@/api/client";

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
      cmp = serverDisplayName(a).localeCompare(serverDisplayName(b));
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

export function RunnerServersPage(): React.JSX.Element {
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

  return (
    <Page>
      <PageHeader>
        <PageTitle>Runner servers</PageTitle>
        <Button
          size="sm"
          onClick={() => void navigate({ to: "/integrations/runner/add" })}
        >
          <Plus {...ICON_INLINE} />
          Add a server
        </Button>
      </PageHeader>

      <p className="-mt-2 mb-4 max-w-3xl text-sm text-muted-foreground">
        Runners sit on your own hosts and collect the evidence investigations
        need. Read-only by default; remediation is enabled per server.
      </p>

      {removeError !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Remove failed</AlertTitle>
          <AlertDescription>{removeError}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div role="status" aria-label="Loading servers" className="py-6">
          <Spinner className="size-4" />
        </div>
      )}

      {isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Failed to load servers</AlertTitle>
          <AlertDescription>
            Something went wrong loading your servers. It will retry
            automatically.
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && connectedRunners.length > 1 && (
        <Field className="mb-3 max-w-60">
          <FieldLabel htmlFor="server-sort">Sort by</FieldLabel>
          <NativeSelect
            id="server-sort"
            value={sortField}
            onChange={(e) => handleSort(e.currentTarget.value as SortField)}
          >
            <NativeSelectOption value="hostname">Name</NativeSelectOption>
            <NativeSelectOption value="status">Status</NativeSelectOption>
            <NativeSelectOption value="services">Services</NativeSelectOption>
            <NativeSelectOption value="lastSeen">Last seen</NativeSelectOption>
          </NativeSelect>
        </Field>
      )}

      {!isLoading && !isError && connectedRunners.length > 0 && (
        <div className="flex flex-col gap-3">
          {sorted.map((runner) => (
            <ServerCard
              key={runner.token}
              runner={runner}
              actions={
                <Button
                  variant="outline"
                  size="xs"
                  disabled={removing === runner.token}
                  aria-label={`Remove server ${serverDisplayName(runner)}`}
                  onClick={() => void handleRemove(runner.token)}
                >
                  {removing === runner.token && <Spinner className="size-3" />}
                  Remove
                </Button>
              }
            />
          ))}
        </div>
      )}
    </Page>
  );
}
