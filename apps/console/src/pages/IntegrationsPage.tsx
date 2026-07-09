import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { GitHubIntegrationStatus } from "@nightwatch/shared";

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

export function IntegrationsPage(): React.JSX.Element {
  const navigate = useNavigate();

  const { data: status, isLoading } = useQuery<GitHubIntegrationStatus>({
    queryKey: ["github-integration"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
  });

  const configured = status?.configured === true;

  return (
    <Page>
      <PageHeader>
        <PageTitle>Integrations</PageTitle>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Let investigations read the bound repository, verify a fix, and
            propose it as a draft pull request. Nightwatch never merges.
          </CardDescription>
          <CardAction className="self-center">
            {isLoading ? (
              <Spinner className="size-4" />
            ) : configured ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-success">
                  Connected
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void navigate({ to: "/integrations/github" })}
                >
                  Manage
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => void navigate({ to: "/integrations/github" })}
              >
                Connect GitHub
              </Button>
            )}
          </CardAction>
        </CardHeader>
      </Card>
    </Page>
  );
}
