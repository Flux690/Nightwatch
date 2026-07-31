import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";
import { Boxes, Server } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/api/client";

interface IntegrationRow {
  title: string;
  logo: React.ReactNode;
  to: string;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
  // "muted" for in-between states that are configured but not yet proven.
  statusVariant?: "success" | "muted";
}

function CatalogRow({
  row,
  onOpen,
}: {
  row: IntegrationRow;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={row.title}
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left not-last:border-b not-last:border-border hover:bg-surface-hover"
    >
      <span className="flex size-8 shrink-0 items-center justify-center">
        {row.logo}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
      {row.isLoading ? (
        <Spinner className="size-3" />
      ) : (
        <span
          className={cn(
            "shrink-0 text-sm",
            row.status !== null && row.statusVariant !== "muted"
              ? "text-success"
              : "text-muted-foreground",
          )}
        >
          {row.status ?? "Not connected"}
        </span>
      )}
    </button>
  );
}

/* The integrations catalog: a full-width page, grouped Installed / All like an
   extensions view. Rows open the existing config pages. */
export function IntegrationsPage(): React.JSX.Element {
  const navigate = useNavigate();

  const { data: github, isLoading: githubLoading } =
    useQuery<GitHubIntegrationStatus>({
      queryKey: ["github-integration"],
      queryFn: () =>
        apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
    });

  const { data: runners, isLoading: runnersLoading } = useQuery<RunnerRecord[]>(
    {
      queryKey: ["runners"],
      queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    },
  );

  const { data: ingest, isLoading: ingestLoading } = useQuery<{
    configured: boolean;
    lastReceivedAt: string | null;
  }>({
    queryKey: ["alertmanager-integration"],
    queryFn: () =>
      apiFetch<{ configured: boolean; lastReceivedAt: string | null }>(
        "/api/integrations/alertmanager",
      ),
  });

  const { data: prometheus, isLoading: prometheusLoading } =
    useQuery<PrometheusIntegrationStatus>({
      queryKey: ["prometheus-integration"],
      queryFn: () =>
        apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
    });

  const { data: loki, isLoading: lokiLoading } =
    useQuery<LokiIntegrationStatus>({
      queryKey: ["loki-integration"],
      queryFn: () => apiFetch<LokiIntegrationStatus>("/api/integrations/loki"),
    });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);

  // Two entries, not one: a Docker host and a Kubernetes cluster install
  // differently and are addressed differently, so each is its own integration.
  function platformRow(
    platform: "docker" | "kubernetes",
    title: string,
    noun: string,
  ): IntegrationRow {
    const count = connectedRunners.filter(
      (r) => r.platform === platform,
    ).length;
    return {
      title,
      logo:
        platform === "docker" ? (
          <Server className="size-5 text-muted-foreground" />
        ) : (
          <Boxes className="size-5 text-muted-foreground" />
        ),
      // Never past the platform's own page: the wizard is a step you choose
      // from there, not somewhere you land.
      to: `/integrations/${platform}`,
      isLoading: runnersLoading,
      status: count > 0 ? `${count} ${count === 1 ? noun : `${noun}s`}` : null,
    };
  }

  const rows: IntegrationRow[] = [
    platformRow("docker", "Docker hosts", "host"),
    platformRow("kubernetes", "Kubernetes clusters", "cluster"),
    {
      title: "Alertmanager",
      logo: <img src="/logos/alertmanager.svg" alt="" className="size-5" />,
      to: "/integrations/alertmanager",
      isLoading: ingestLoading,
      status:
        ingest?.configured !== true
          ? null
          : ingest.lastReceivedAt !== null
            ? "Receiving"
            : "Waiting for first alert",
      statusVariant: ingest?.lastReceivedAt !== null ? "success" : "muted",
    },
    {
      title: "Prometheus",
      logo: <img src="/logos/prometheus.svg" alt="" className="size-5" />,
      to: "/integrations/prometheus",
      isLoading: prometheusLoading,
      status: prometheus?.configured === true ? "Connected" : null,
    },
    {
      title: "Loki",
      logo: <img src="/logos/loki.svg" alt="" className="size-5" />,
      to: "/integrations/loki",
      isLoading: lokiLoading,
      status: loki?.configured === true ? "Connected" : null,
    },
    {
      title: "GitHub",
      logo: <img src="/logos/github.svg" alt="" className="size-5" />,
      to: "/integrations/github",
      isLoading: githubLoading,
      status: github?.configured === true ? "Connected" : null,
    },
  ];

  const installed = rows.filter((r) => r.status !== null);
  const available = rows.filter((r) => r.status === null);

  function group(label: string, items: IntegrationRow[]): React.JSX.Element {
    return (
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">
          {label}
        </h2>
        <Card className="gap-0 py-0">
          {items.map((row) => (
            <CatalogRow
              key={row.title}
              row={row}
              onOpen={() => void navigate({ to: row.to })}
            />
          ))}
        </Card>
      </section>
    );
  }

  return (
    <Page>
      <PageHeader>
        <PageTitle>Integrations</PageTitle>
      </PageHeader>
      {installed.length > 0 && group("Installed", installed)}
      {available.length > 0 && group("All integrations", available)}
    </Page>
  );
}
