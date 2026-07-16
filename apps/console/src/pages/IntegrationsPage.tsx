import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwatch/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { apiFetch } from "@/api/client";

// One card per plug: an integration is either connected (show its state and a
// way in) or not (show the action that connects it).
function IntegrationCard({
  title,
  description,
  isLoading,
  status,
  statusVariant = "success",
  connectLabel,
  onOpen,
}: {
  title: string;
  description: string;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
  // "muted" for in-between states that are configured but not yet proven.
  statusVariant?: "success" | "muted";
  connectLabel: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction className="self-center">
          {isLoading ? (
            <Spinner className="size-4" />
          ) : status !== null ? (
            <div className="flex items-center gap-3">
              <span
                className={
                  statusVariant === "success"
                    ? "text-sm font-medium text-success"
                    : "text-sm font-medium text-muted-foreground"
                }
              >
                {status}
              </span>
              <Button size="sm" variant="secondary" onClick={onOpen}>
                Manage
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={onOpen}>
              {connectLabel}
            </Button>
          )}
        </CardAction>
      </CardHeader>
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
      <div className="flex flex-col gap-4">
        <IntegrationCard
          title="Nightwatch Runner"
          description="Sits on your own hosts. Collects container and host evidence for investigations, and executes remediation you approve. Read-only by default; remediation is enabled per server."
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
          description="Forward alerts from the Alertmanager you already run. One credential for the whole fleet, set up once - Nightwatch ships no monitoring of its own."
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
          description="Let investigations query your metrics - was it climbing for hours or did it spike? Works with zero runners installed."
          isLoading={prometheusLoading}
          status={prometheus?.configured === true ? "Connected" : null}
          connectLabel="Connect Prometheus"
          onOpen={() => void navigate({ to: "/integrations/prometheus" })}
        />

        <IntegrationCard
          title="GitHub"
          description="Let investigations read the bound repository, verify a fix, and propose it as a draft pull request. Nightwatch never merges."
          isLoading={githubLoading}
          status={github?.configured === true ? "Connected" : null}
          connectLabel="Connect GitHub"
          onOpen={() => void navigate({ to: "/integrations/github" })}
        />
      </div>
    </Page>
  );
}
