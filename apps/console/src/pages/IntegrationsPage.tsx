import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AlertSourceKind,
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  MetricsSourceStatus,
  RunnerRecord,
} from "@nightwarden/shared";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";

import { Page, SectionHeading } from "@/components/layout/Page";
import { Card } from "@/components/ui/card";
import { StatusText } from "@/components/ui/status";
import { IntegrationLogo } from "@/components/layout/IntegrationHeader";
import { apiFetch } from "@/api/client";
import { INTEGRATION_CATALOG } from "./integrationCatalog";

// Named for what a connection gives an investigation. A section appears with
// its first row.
const CATEGORIES = ["Alerting", "Metrics", "Logs", "Fleet", "Code"] as const;

type Category = (typeof CATEGORIES)[number];

interface IntegrationRow {
  title: string;
  description: string;
  category: Category;
  logo: string;
  to: string;
  // null renders no status line at all: six repetitions of "Not connected"
  // crowd out the ones that matter. "muted" is configured but not yet proven.
  status: string | null;
  statusVariant?: "success" | "muted";
}

/* A full-width row, not a tile. The whole row is the link, so there is no
   Connect button duplicating the one action it already has. */
function CatalogRow({ row }: { row: IntegrationRow }): React.JSX.Element {
  return (
    <li className="not-last:border-b not-last:border-border">
      <Link
        to={row.to}
        aria-label={row.title}
        className="flex items-start gap-3 px-4 py-3 no-underline transition-colors hover:bg-card-hover"
      >
        <IntegrationLogo logo={row.logo} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm leading-tight font-medium text-foreground">
            {row.title}
          </span>
          <span className="text-sm text-muted-foreground">
            {row.description}
          </span>
        </span>
        {row.status !== null && (
          <StatusText tone={row.statusVariant === "muted" ? "muted" : "ok"}>
            {row.status}
          </StatusText>
        )}
      </Link>
    </li>
  );
}

interface AlertSourceStatus {
  configured: boolean;
  lastReceivedAt: string | null;
}

function useAlertSource(kind: AlertSourceKind): AlertSourceStatus | undefined {
  return useQuery<AlertSourceStatus>({
    queryKey: ["alert-source", kind],
    queryFn: () =>
      apiFetch<AlertSourceStatus>(`/api/integrations/alerting/${kind}`),
  }).data;
}

/* The status line is delivery, not configuration: a minted credential nobody
   has posted with says so, because a card reading Connected on a sender that
   has never delivered is the failure this whole surface exists to catch. */
function alertSourceCard(
  kind: AlertSourceKind,
  status: AlertSourceStatus | undefined,
): IntegrationRow {
  const identity = INTEGRATION_CATALOG[kind];
  return {
    title: identity.label,
    description: identity.description,
    category: "Alerting",
    logo: identity.logo,
    to: `/integrations/alerting/${kind}`,
    status:
      status?.configured !== true
        ? null
        : status.lastReceivedAt !== null
          ? "Receiving"
          : "Waiting for first alert",
    statusVariant: status?.lastReceivedAt !== null ? "success" : "muted",
  };
}

export function IntegrationsPage(): React.JSX.Element {
  const { data: github } = useQuery<GitHubIntegrationStatus>({
    queryKey: ["github-integration"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });

  // One query per sender: each has its own credential and its own delivery
  // proof, so one status line can never stand for the other's.
  const alertmanager = useAlertSource("alertmanager");
  const grafana = useAlertSource("grafana");

  // One query for every source: the list draws a row per product, and each
  // says whether that product is connected.
  const { data: metrics } = useQuery<MetricsSourceStatus[]>({
    queryKey: ["metrics-sources"],
    queryFn: () => apiFetch<MetricsSourceStatus[]>("/api/integrations/metrics"),
  });

  const { data: loki } = useQuery<LokiIntegrationStatus>({
    queryKey: ["loki-integration"],
    queryFn: () => apiFetch<LokiIntegrationStatus>("/api/integrations/loki"),
  });

  const connectedRunners = (runners ?? []).filter((r) => r.hostname !== null);

  // Two entries, not one: a Docker host and a Kubernetes cluster install
  // differently and are addressed differently. Each routes to its own list
  // rather than its wizard, which is a step you choose from there.
  function platformCard(
    platform: "docker" | "kubernetes",
    noun: string,
  ): IntegrationRow {
    const identity = INTEGRATION_CATALOG[platform];
    const count = connectedRunners.filter(
      (r) => r.platform === platform,
    ).length;
    return {
      title: identity.label,
      description: identity.description,
      category: "Fleet",
      logo: identity.logo,
      to: `/integrations/${platform}`,
      status: count > 0 ? `${count} ${count === 1 ? noun : `${noun}s`}` : null,
    };
  }

  const rows: IntegrationRow[] = [
    platformCard("docker", "host"),
    platformCard("kubernetes", "cluster"),
    alertSourceCard("alertmanager", alertmanager),
    alertSourceCard("grafana", grafana),
    ...METRICS_SOURCE_KINDS.map((kind): IntegrationRow => {
      const identity = INTEGRATION_CATALOG[kind];
      const source = (metrics ?? []).find((b) => b.kind === kind);
      /* A source with no rules endpoint is connected and still cannot confirm
         a recovery, so the row says which rather than a flat "Connected". */
      const blind = source !== undefined && source.rules === null;
      return {
        title: identity.label,
        description: identity.description,
        category: "Metrics",
        logo: identity.logo,
        to: `/integrations/metrics/${kind}`,
        status:
          source === undefined
            ? null
            : blind
              ? "Connected, no rules endpoint"
              : "Connected",
        statusVariant: blind ? "muted" : "success",
      };
    }),
    {
      title: INTEGRATION_CATALOG.loki.label,
      description: INTEGRATION_CATALOG.loki.description,
      logo: INTEGRATION_CATALOG.loki.logo,
      category: "Logs",
      to: "/integrations/loki",
      status: loki?.configured === true ? "Connected" : null,
    },
    {
      title: INTEGRATION_CATALOG.github.label,
      description: INTEGRATION_CATALOG.github.description,
      logo: INTEGRATION_CATALOG.github.logo,
      category: "Code",
      to: "/integrations/github",
      status: github?.configured === true ? "Connected" : null,
    },
  ];

  return (
    <Page crumbs={[{ label: "Integrations" }]} measure="form">
      <div className="flex flex-col gap-8">
        {CATEGORIES.map((category) => {
          const inCategory = rows.filter((r) => r.category === category);
          if (inCategory.length === 0) return null;
          return (
            <section key={category} className="flex flex-col gap-3">
              <SectionHeading>{category}</SectionHeading>
              <Card className="gap-0 py-0">
                <ul className="m-0 flex list-none flex-col p-0">
                  {inCategory.map((row) => (
                    <CatalogRow key={row.title} row={row} />
                  ))}
                </ul>
              </Card>
            </section>
          );
        })}
      </div>
    </Page>
  );
}
