import { ALERT_SOURCE_KINDS, METRICS_SOURCE_KINDS } from "@nightwarden/shared";

/* One description serves the grid card and the page header, so the two can
   never drift apart. */

export const INTEGRATION_SLUGS = [
  "docker",
  "kubernetes",
  ...ALERT_SOURCE_KINDS,
  ...METRICS_SOURCE_KINDS,
  "loki",
  "sentry",
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
        "Read container state, logs and stats, and restart a container when you approve it.",
    },
    kubernetes: {
      label: "Kubernetes clusters",
      logo: "/logos/kubernetes.svg",
      description:
        "Read pod state, events and logs, and restart a workload when you approve it.",
    },
    alertmanager: {
      label: "Prometheus Alertmanager",
      logo: "/logos/prometheus.svg",
      description:
        "Open an investigation the moment Alertmanager fires, and close it when the alert clears.",
    },
    grafana: {
      label: "Grafana Alerting",
      logo: "/logos/grafana.svg",
      description:
        "Open an investigation the moment Grafana Alerting fires, and close it when the alert clears.",
    },
    prometheus: {
      label: "Prometheus",
      logo: "/logos/prometheus.svg",
      description:
        "Query metrics to confirm a symptom, chart the series behind it, and check whether the rule still fires.",
    },
    victoriametrics: {
      label: "VictoriaMetrics",
      logo: "/logos/victoriametrics.svg",
      description:
        "Query metrics from vmsingle or vmselect, and read alerting rules from vmalert.",
    },
    mimir: {
      label: "Grafana Mimir",
      logo: "/logos/mimir.svg",
      description:
        "Query metrics from self-hosted Mimir or Grafana Cloud Metrics, one tenant at a time.",
    },
    thanos: {
      label: "Thanos",
      logo: "/logos/thanos.svg",
      description:
        "Query metrics across every store behind Thanos, and read the rules it aggregates.",
    },
    amp: {
      label: "Amazon Managed Prometheus",
      logo: "/logos/amp.svg",
      description:
        "Query metrics from an Amazon Managed Prometheus workspace, signed with your AWS credentials.",
    },
    loki: {
      label: "Grafana Loki",
      logo: "/logos/loki.svg",
      description:
        "Read the log lines around an alert and quote them in the report as evidence.",
    },
    sentry: {
      label: "Sentry",
      logo: "/logos/sentry.svg",
      description:
        "Read the exceptions and stack traces around an alert, and the release each one was running.",
    },
    github: {
      label: "GitHub",
      logo: "/logos/github.svg",
      description:
        "Read the repository, verify a fix in a sandbox, and open a draft pull request.",
    },
  };
