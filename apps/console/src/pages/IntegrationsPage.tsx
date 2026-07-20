import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  PrometheusIntegrationStatus,
  LokiIntegrationStatus,
  RunnerRecord,
} from "@nightwatch/shared";
import { Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { apiFetch } from "@/api/client";

// One card per plug: logo, name, a quiet status line, and an always-present
// action - everything else lives on the integration's own page.
function IntegrationCard({
  title,
  logo,
  isLoading,
  status,
  statusVariant = "success",
  onOpen,
}: {
  title: string;
  logo: React.ReactNode;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
  // "muted" for in-between states that are configured but not yet proven.
  statusVariant?: "success" | "muted";
  onOpen: () => void;
}): React.JSX.Element {
  const configured = status !== null;
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
      className="cursor-pointer items-center gap-2 px-4 py-6 text-center transition-colors hover:ring-ring/60"
    >
      <span className="flex h-10 items-center">{logo}</span>
      <span className="text-sm font-medium">{title}</span>
      {isLoading ? (
        <Spinner className="size-4" />
      ) : (
        <>
          {configured && (
            <span
              className={
                statusVariant === "success"
                  ? "text-sm text-success"
                  : "text-sm text-muted-foreground"
              }
            >
              {status}
            </span>
          )}
          <Button
            size="sm"
            variant={configured ? "secondary" : "default"}
            className="mt-1"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {configured ? "Manage" : "Connect"}
          </Button>
        </>
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
          logo={<img src="/logos/alertmanager.svg" alt="" className="size-9" />}
          isLoading={ingestLoading}
          status={
            ingest?.configured !== true
              ? null
              : ingest.lastReceivedAt !== null
                ? "Receiving"
                : "Waiting for first alert"
          }
          statusVariant={ingest?.lastReceivedAt !== null ? "success" : "muted"}
          onOpen={() => void navigate({ to: "/integrations/alertmanager" })}
        />

        <IntegrationCard
          title="Prometheus"
          logo={<img src="/logos/prometheus.svg" alt="" className="size-9" />}
          isLoading={prometheusLoading}
          status={prometheus?.configured === true ? "Connected" : null}
          onOpen={() => void navigate({ to: "/integrations/prometheus" })}
        />

        <IntegrationCard
          title="Loki"
          logo={<img src="/logos/loki.svg" alt="" className="size-9" />}
          isLoading={lokiLoading}
          status={loki?.configured === true ? "Connected" : null}
          onOpen={() => void navigate({ to: "/integrations/loki" })}
        />

        <IntegrationCard
          title="GitHub"
          logo={<img src="/logos/github.svg" alt="" className="size-9" />}
          isLoading={githubLoading}
          status={github?.configured === true ? "Connected" : null}
          onOpen={() => void navigate({ to: "/integrations/github" })}
        />
      </div>
    </Page>
  );
}
