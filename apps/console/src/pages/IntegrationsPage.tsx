import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwatch/shared";
import { BellRing, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { apiFetch } from "@/api/client";

// One card per plug: logo, name, and either the connect action or the live
// status - everything else lives on the integration's own page.
function IntegrationCard({
  title,
  logo,
  isLoading,
  status,
  statusVariant = "success",
  connectLabel,
  onOpen,
}: {
  title: string;
  logo: React.ReactNode;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
  // "muted" for in-between states that are configured but not yet proven.
  statusVariant?: "success" | "muted";
  connectLabel: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer items-center gap-3 px-4 py-6 text-center transition-colors hover:ring-ring/60"
    >
      <span className="flex h-10 items-center">{logo}</span>
      <span className="text-sm font-medium">{title}</span>
      {isLoading ? (
        <Spinner className="size-4" />
      ) : status !== null ? (
        <span
          className={
            statusVariant === "success"
              ? "text-sm font-medium text-success"
              : "text-sm font-medium text-muted-foreground"
          }
        >
          {status}
        </span>
      ) : (
        <Button
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {connectLabel}
        </Button>
      )}
    </Card>
  );
}

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
    queryKey: ["ingest-credential"],
    queryFn: () =>
      apiFetch<{ configured: boolean; lastReceivedAt: string | null }>(
        "/api/ingest-credential",
      ),
  });

  const { data: prometheus, isLoading: prometheusLoading } =
    useQuery<PrometheusIntegrationStatus>({
      queryKey: ["prometheus-integration"],
      queryFn: () =>
        apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
    });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);

  return (
    <Page>
      <PageHeader>
        <PageTitle>Integrations</PageTitle>
      </PageHeader>
      <p className="-mt-2 mb-6 text-sm text-muted-foreground">
        Plug Nightwatch into the stack you already run.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <IntegrationCard
          title="Nightwatch Runner"
          logo={<Server className="size-9 text-muted-foreground" />}
          isLoading={runnersLoading}
          status={
            connectedRunners.length > 0
              ? `${connectedRunners.length} ${connectedRunners.length === 1 ? "server" : "servers"}`
              : null
          }
          connectLabel="Add a server"
          onOpen={() =>
            void navigate({
              to:
                connectedRunners.length > 0
                  ? "/integrations/runner"
                  : "/integrations/runner/add",
            })
          }
        />

        <IntegrationCard
          title="Alertmanager"
          logo={<BellRing className="size-9 text-muted-foreground" />}
          isLoading={ingestLoading}
          status={
            ingest?.configured !== true
              ? null
              : ingest.lastReceivedAt !== null
                ? "Receiving"
                : "Waiting for first alert"
          }
          statusVariant={ingest?.lastReceivedAt !== null ? "success" : "muted"}
          connectLabel="Set up"
          onOpen={() => void navigate({ to: "/integrations/alertmanager" })}
        />

        <IntegrationCard
          title="Prometheus"
          logo={<img src="/logos/prometheus.svg" alt="" className="size-9" />}
          isLoading={prometheusLoading}
          status={prometheus?.configured === true ? "Connected" : null}
          connectLabel="Connect Prometheus"
          onOpen={() => void navigate({ to: "/integrations/prometheus" })}
        />

        <IntegrationCard
          title="GitHub"
          logo={<img src="/logos/github.svg" alt="" className="size-9" />}
          isLoading={githubLoading}
          status={github?.configured === true ? "Connected" : null}
          connectLabel="Connect GitHub"
          onOpen={() => void navigate({ to: "/integrations/github" })}
        />
      </div>
    </Page>
  );
}
