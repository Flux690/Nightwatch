import type { MetricsSourceKind } from "@nightwarden/shared";

/* What differs between products, as data rather than behaviour. A gap declared
   here is one a tool result states out loud, because an empty answer reads to
   the agent as "nothing is wrong". */
export interface MetricsPreset {
  // The product's own name, as its vendor writes it.
  label: string;
  /* Whether /api/v1/metadata answers at all. VictoriaMetrics serves an empty
     placeholder for every metric ever queried, so absence there is a fact about
     VictoriaMetrics and not about the metric. */
  metricMetadata: boolean;
  /* Whether the query endpoint also serves /api/v1/rules. False means a rules
     URL has to be configured separately or recovery can never be confirmed:
     VictoriaMetrics serves rules only from vmalert, a separate binary. */
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
};
