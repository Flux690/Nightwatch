import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Platform, RunnerRecord } from "@nightwarden/shared";
import { Boxes, Plus, Server } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ServerCard, runnerDisplayName } from "@/components/layout/ServerCard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ICON_DISPLAY, ICON_INLINE } from "@/lib/iconProps";
import { apiFetch } from "@/api/client";
import { INTEGRATION_CATALOG } from "./integrationCatalog";
import { IntegrationHeader } from "@/components/layout/IntegrationHeader";

// The two platforms are genuinely different things - a machine running
// containers, and a cluster - so each gets its own noun, page and install path.

export const PLATFORM_COPY: Record<
  Platform,
  { plural: string; singular: string; emptyHint: string }
> = {
  docker: {
    plural: "Docker hosts",
    singular: "Docker host",
    emptyHint:
      "The runner connected but sees no containers. That usually means the Docker socket is not mounted.",
  },
  kubernetes: {
    plural: "Kubernetes clusters",
    singular: "Kubernetes cluster",
    emptyHint:
      "The runner connected but sees no workloads. That usually means its service account cannot list them.",
  },
};

type SortField = "name" | "status" | "lastSeen" | "services";

const SORT_LABEL: Record<SortField, string> = {
  name: "Name",
  status: "Status",
  services: "Services",
  lastSeen: "Last seen",
};
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
function runsPlatform(runner: RunnerRecord, platform: Platform): boolean {
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
    <Page
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: copy.plural },
      ]}
      /* The empty state carries this action itself, so offering it twice on
         the one screen where it is the only thing to do reads as a mistake. */
      controls={
        connected.length > 0 ? (
          <Button
            className="ml-auto"
            size="sm"
            onClick={() =>
              void navigate({ to: `/integrations/${platform}/add` })
            }
          >
            <Plus {...ICON_INLINE} />
            Add a {copy.singular.toLowerCase()}
          </Button>
        ) : undefined
      }
    >
      {/* Withheld while the list is empty: the empty state already says what
          this is and what to do, and saying it twice reads as a stutter. */}
      {connected.length > 0 && (
        <div className="-mt-2 mb-4">
          <IntegrationHeader identity={INTEGRATION_CATALOG[platform]} />
        </div>
      )}

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
        <Field className="mb-3">
          <FieldLabel id="runner-sort-label">Sort by</FieldLabel>
          <Select
            items={SORT_LABEL}
            value={sortField}
            onValueChange={(value) => handleSort(value as SortField)}
          >
            <SelectTrigger id="runner-sort" className="max-w-control-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {/* An empty fleet is the ordinary first state, so the list says what to
          do next rather than sending you somewhere. */}
      {!isLoading && !isError && connected.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {platform === "docker" ? (
                <Server {...ICON_DISPLAY} />
              ) : (
                <Boxes {...ICON_DISPLAY} />
              )}
            </EmptyMedia>
            <EmptyTitle>No {copy.plural.toLowerCase()} yet</EmptyTitle>
            <EmptyDescription>
              Install a runner to connect your first{" "}
              {copy.singular.toLowerCase()}. It takes one command.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            onClick={() =>
              void navigate({ to: `/integrations/${platform}/add` })
            }
          >
            <Plus {...ICON_INLINE} />
            Add a {copy.singular.toLowerCase()}
          </Button>
        </Empty>
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
