import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  AlertSourceKind,
  GitHubIntegrationStatus,
  LokiIntegrationStatus,
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";
import { Boxes, Server } from "lucide-react";

import { Page, SECTION_HEADING } from "@/components/layout/Page";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/api/client";
import { ALERT_SOURCE_CONTENT } from "./alertSourceContent";

// Named for what a connection gives an investigation. A section appears with
// its first card.
const CATEGORIES = ["Alerting", "Metrics", "Logs", "Fleet", "Code"] as const;

type Category = (typeof CATEGORIES)[number];

interface IntegrationCard {
  title: string;
  description: string;
  category: Category;
  logo: React.ReactNode;
  to: string;
  // null renders no status line at all: six repetitions of "Not connected"
  // crowd out the ones that matter. "muted" is configured but not yet proven.
  status: string | null;
  statusVariant?: "success" | "muted";
}

function CatalogCard({
  card,
  onOpen,
}: {
  card: IntegrationCard;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={card.title}
      onClick={onOpen}
      className="flex h-39 flex-col gap-3 rounded-lg bg-card p-4 text-left ring-1 ring-border transition-colors hover:bg-surface-hover"
    >
      <span className="flex items-center gap-2">
        {/* The square is white because vendor logos are drawn for light
            ground; anything monochrome inherits dark ink from it. */}
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white text-background">
          {card.logo}
        </span>
        <span className="min-w-0 text-sm leading-tight font-medium">
          {card.title}
        </span>
      </span>
      <span className="line-clamp-3 text-sm text-muted-foreground">
        {card.description}
      </span>
      {card.status !== null && (
        <span
          className={cn(
            "mt-auto text-sm",
            card.statusVariant === "muted"
              ? "text-muted-foreground"
              : "text-success",
          )}
        >
          {card.status}
        </span>
      )}
    </button>
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
  description: string,
  status: AlertSourceStatus | undefined,
): IntegrationCard {
  const content = ALERT_SOURCE_CONTENT[kind];
  return {
    title: content.label,
    description,
    category: "Alerting",
    logo: <img src={content.logo} alt="" className="size-5" />,
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
  const navigate = useNavigate();

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

  const { data: prometheus } = useQuery<PrometheusIntegrationStatus>({
    queryKey: ["prometheus-integration"],
    queryFn: () =>
      apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
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
    title: string,
    description: string,
    noun: string,
  ): IntegrationCard {
    const count = connectedRunners.filter(
      (r) => r.platform === platform,
    ).length;
    return {
      title,
      description,
      category: "Fleet",
      logo:
        platform === "docker" ? (
          <Server className="size-5" />
        ) : (
          <Boxes className="size-5" />
        ),
      to: `/integrations/${platform}`,
      status: count > 0 ? `${count} ${count === 1 ? noun : `${noun}s`}` : null,
    };
  }

  const cards: IntegrationCard[] = [
    platformCard(
      "docker",
      "Docker hosts",
      "Read container state, logs and stats, and restart a service on approval.",
      "host",
    ),
    platformCard(
      "kubernetes",
      "Kubernetes clusters",
      "Read pod state, events and logs, and roll a deployment on approval.",
      "cluster",
    ),
    alertSourceCard(
      "alertmanager",
      "Forward the alerts that open an investigation the moment one fires.",
      alertmanager,
    ),
    alertSourceCard(
      "grafana",
      "Forward alerts from Grafana's own alerting, through a webhook contact point.",
      grafana,
    ),
    {
      title: "Prometheus",
      description:
        "Query your metrics to confirm a symptom and chart what backs it.",
      category: "Metrics",
      logo: <img src="/logos/prometheus.svg" alt="" className="size-5" />,
      to: "/integrations/prometheus",
      status: prometheus?.configured === true ? "Connected" : null,
    },
    {
      title: "Loki",
      description:
        "Search your logs for the errors behind an alert and quote them as evidence.",
      category: "Logs",
      logo: <img src="/logos/loki.svg" alt="" className="size-5" />,
      to: "/integrations/loki",
      status: loki?.configured === true ? "Connected" : null,
    },
    {
      title: "GitHub",
      description:
        "Read the code behind a failure, verify a fix, and open a draft pull request.",
      category: "Code",
      logo: <img src="/logos/github.svg" alt="" className="size-5" />,
      to: "/integrations/github",
      status: github?.configured === true ? "Connected" : null,
    },
  ];

  return (
    <Page crumbs={[{ label: "Integrations" }]} measure="form">
      <div className="flex flex-col gap-8">
        {CATEGORIES.map((category) => {
          const inCategory = cards.filter((c) => c.category === category);
          if (inCategory.length === 0) return null;
          return (
            <section key={category} className="flex flex-col gap-3">
              <h2 className={SECTION_HEADING}>{category}</h2>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                {inCategory.map((card) => (
                  <CatalogCard
                    key={card.title}
                    card={card}
                    onOpen={() => void navigate({ to: card.to })}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Page>
  );
}
