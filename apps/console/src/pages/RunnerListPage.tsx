import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Platform, RunnerRecord } from "@nightwarden/shared";
import { Plus } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ServerCard, runnerDisplayName } from "@/components/layout/ServerCard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { ICON_INLINE } from "@/lib/iconProps";
import { apiFetch } from "@/api/client";

// The two platforms are genuinely different things - a machine running
// containers, and a cluster - so each gets its own noun, page and install path.

export const PLATFORM_COPY: Record<
  Platform,
  { plural: string; singular: string; blurb: string; emptyHint: string }
> = {
  docker: {
    plural: "Docker hosts",
    singular: "Docker host",
    blurb:
      "A runner sits on each host and collects the evidence investigations need. Read-only by default; every write waits for your approval.",
    emptyHint:
      "The runner connected but sees no containers. That usually means the Docker socket is not mounted.",
  },
  kubernetes: {
    plural: "Kubernetes clusters",
    singular: "Kubernetes cluster",
    blurb:
      "One runner per cluster, not per node. It collects the evidence investigations need, read-only by default; every write waits for your approval.",
    emptyHint:
      "The runner connected but sees no workloads. That usually means its service account cannot list them.",
  },
};

type SortField = "name" | "status" | "lastSeen" | "services";
type SortDir = "asc" | "desc";

function compareRunners(
  a: RunnerRecord,
  b: RunnerRecord,
  field: SortField,
  dir: SortDir,
): number {
  let cmp = 0;
  switch (field) {
    case "name":
      cmp = runnerDisplayName(a).localeCompare(runnerDisplayName(b));
      break;
    case "status": {
      cmp = (a.online ? 1 : 0) - (b.online ? 1 : 0);
      break;
    }
    case "lastSeen": {
      const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
      const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
      cmp = aTime - bTime;
      break;
    }
    case "services": {
      const aCount = a.manifest?.services.length ?? 0;
      const bCount = b.manifest?.services.length ?? 0;
      cmp = aCount - bCount;
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
}

// A runner belongs to the platform its row names, decided at onboarding, so the
// two lists can never disagree with what the runner actually is.
export function runsPlatform(
  runner: RunnerRecord,
  platform: Platform,
): boolean {
  return runner.platform === platform;
}

export function RunnerListPage({
  platform,
}: {
  platform: Platform;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const copy = PLATFORM_COPY[platform];

  const {
    data: runners,
    isLoading,
    isError,
  } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    refetchInterval: 30_000,
  });

  const connected = (runners ?? []).filter(
    (r) => r.hostname !== null && runsPlatform(r, platform),
  );
  const sorted = [...connected].sort((a, b) =>
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
        err instanceof Error ? err.message : "Failed to remove runner",
      );
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Page>
      <PageHeader>
        <PageTitle>{copy.plural}</PageTitle>
        <Button
          size="sm"
          onClick={() => void navigate({ to: `/integrations/${platform}/add` })}
        >
          <Plus {...ICON_INLINE} />
          Add a {copy.singular.toLowerCase()}
        </Button>
      </PageHeader>

      <p className="-mt-2 mb-4 max-w-3xl text-sm text-muted-foreground">
        {copy.blurb}
      </p>

      {removeError !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Remove failed</AlertTitle>
          <AlertDescription>{removeError}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div
          role="status"
          aria-label={`Loading ${copy.plural.toLowerCase()}`}
          className="py-6"
        >
          <Spinner className="size-4" />
        </div>
      )}

      {isError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Failed to load {copy.plural.toLowerCase()}</AlertTitle>
          <AlertDescription>
            Something went wrong loading them. It will retry automatically.
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && connected.length > 1 && (
        <Field className="mb-3 max-w-60">
          <FieldLabel htmlFor="runner-sort">Sort by</FieldLabel>
          <NativeSelect
            id="runner-sort"
            value={sortField}
            onChange={(e) => handleSort(e.currentTarget.value as SortField)}
          >
            <NativeSelectOption value="name">Name</NativeSelectOption>
            <NativeSelectOption value="status">Status</NativeSelectOption>
            <NativeSelectOption value="services">Services</NativeSelectOption>
            <NativeSelectOption value="lastSeen">Last seen</NativeSelectOption>
          </NativeSelect>
        </Field>
      )}

      {!isLoading && !isError && connected.length > 0 && (
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
                  aria-label={`Remove ${runnerDisplayName(runner)}`}
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
