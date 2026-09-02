import type { MetricsSourceKind } from "@nightwarden/shared";

/* What differs between products, as data rather than behaviour. A gap declared
   here is one a tool result states, because an empty answer reads as healthy. */
export interface MetricsPreset {
  // The product's own name, as its vendor writes it.
  label: string;
  /* VictoriaMetrics serves an empty placeholder for every metric ever queried,
     so absence there is a fact about the server and not about the metric. */
  metricMetadata: boolean;
  /* False means a rules URL must be configured separately or recovery is never
     confirmed: VictoriaMetrics serves rules only from vmalert. */
  rulesOnQueryEndpoint: boolean;
}

export const METRICS_PRESETS: Record<MetricsSourceKind, MetricsPreset> = {
  prometheus: {
    label: "Prometheus",
    metricMetadata: true,
    rulesOnQueryEndpoint: true,
  },
  victoriametrics: {
    label: "VictoriaMetrics",
    metricMetadata: false,
    rulesOnQueryEndpoint: false,
  },
  mimir: {
    // Grafana Labs' own name for it, which is also what a Grafana Cloud user
    // is looking for: Grafana Cloud Metrics is hosted Mimir.
    label: "Grafana Mimir",
    metricMetadata: true,
    // The ruler is a separate service in microservices mode and a different
    // host entirely on Grafana Cloud, so the offer to name one always stands.
    rulesOnQueryEndpoint: true,
  },
  thanos: {
    label: "Thanos",
    metricMetadata: true,
    // The querier aggregates rules from rulers and sidecars, and has honoured
    // the Prometheus filter params since thanos-io#6703 closed in January 2025.
    rulesOnQueryEndpoint: true,
  },
  amp: {
    label: "Amazon Managed Prometheus",
    // Unverified against a live workspace: AMP's rule management API is a
    // separate AWS surface, not necessarily this Prometheus-shaped one.
    metricMetadata: true,
    rulesOnQueryEndpoint: true,
  },
};
