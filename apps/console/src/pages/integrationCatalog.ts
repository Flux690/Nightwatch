import { ALERT_SOURCE_KINDS, METRICS_BACKEND_KINDS } from "@nightwarden/shared";

/* What an integration is called, what it looks like, and what it gives an
   investigation. One description serves the grid card and the page header, so
   the two can never drift apart. */

export const INTEGRATION_SLUGS = [
  "docker",
  "kubernetes",
  ...ALERT_SOURCE_KINDS,
  ...METRICS_BACKEND_KINDS,
  "loki",
  "github",
] as const;

export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export interface IntegrationIdentity {
  label: string;
  logo: string;
  description: string;
}

export const INTEGRATION_CATALOG: Record<IntegrationSlug, IntegrationIdentity> =
  {
    docker: {
      label: "Docker hosts",
      logo: "/logos/docker.svg",
      description:
        "Read container state, logs and stats, and restart a service on approval.",
    },
    kubernetes: {
      label: "Kubernetes clusters",
      logo: "/logos/kubernetes.svg",
      description:
        "Read pod state, events and logs, and roll a deployment on approval.",
    },
    alertmanager: {
      label: "Prometheus Alertmanager",
      logo: "/logos/prometheus.svg",
      description:
        "Forward the alerts that open an investigation the moment one fires.",
    },
    grafana: {
      label: "Grafana Alerting",
      logo: "/logos/grafana.svg",
      description:
        "Forward alerts from Grafana's own alerting, through a webhook contact point.",
    },
    prometheus: {
      label: "Prometheus",
      logo: "/logos/prometheus.svg",
      description:
        "Query the Prometheus you already run to confirm a symptom and chart what backs it.",
    },
    victoriametrics: {
      label: "VictoriaMetrics",
      logo: "/logos/victoriametrics.svg",
      description:
        "Query VictoriaMetrics, single-node or cluster, and read vmalert's rules.",
    },
    mimir: {
      label: "Grafana Mimir",
      logo: "/logos/mimir.svg",
      description:
        "Query Grafana Mimir, self-hosted or as Grafana Cloud Metrics.",
    },
    thanos: {
      label: "Thanos",
      logo: "/logos/thanos.svg",
      description:
        "Query Thanos and read the rules it aggregates from your rulers.",
    },
    loki: {
      label: "Grafana Loki",
      logo: "/logos/loki.svg",
      description:
        "Search your logs for the errors behind an alert and quote them as evidence.",
    },
    github: {
      label: "GitHub",
      logo: "/logos/github.svg",
      description:
        "Read the code behind a failure, verify a fix, and open a draft pull request.",
    },
  };
