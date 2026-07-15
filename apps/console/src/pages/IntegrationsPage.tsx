import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { GitHubIntegrationStatus, RunnerRecord } from "@nightwatch/shared";

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
  connectLabel,
  onOpen,
}: {
  title: string;
  description: string;
  isLoading: boolean;
  // null when the integration is not set up yet.
  status: string | null;
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
              <span className="text-sm font-medium text-success">{status}</span>
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
  }>({
    queryKey: ["ingest-credential"],
    queryFn: () => apiFetch<{ configured: boolean }>("/api/ingest-credential"),
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
          status={ingest?.configured === true ? "Configured" : null}
          connectLabel="Set up"
          onOpen={() => void navigate({ to: "/integrations/alertmanager" })}
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
