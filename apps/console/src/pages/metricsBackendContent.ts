import type { MetricsBackendKind } from "@nightwarden/shared";

/* Only text differs between backends. Connecting, probing and disconnecting are
   one code path serving every kind, the way the alert sources are. What is
   worth saying per product is where the rules live and what breaks quietly. */
export interface MetricsBackendContent {
  label: string;
  logo: string;
  blurb: string;
  // What the card says on the Integrations grid, where the vendor's other
  // names have to be findable by someone searching for them.
  cardDescription: string;
  queryPlaceholder: string;
  queryHelp: string;
  // Absent when the query endpoint serves its own rules and the second field is
  // an unusual thing to fill in rather than the normal one.
  rulesPlaceholder: string;
  rulesHelp: string;
  // Auth presets this product hands people, in the console's own words.
  authHelp: string;
  warnings: string[];
}

const RULES_WHY =
  "Without it an investigation can never confirm the alert stopped firing, so it will not reach Resolved on its own.";

export const METRICS_BACKEND_CONTENT: Record<
  MetricsBackendKind,
  MetricsBackendContent
> = {
  prometheus: {
    label: "Prometheus",
    logo: "/logos/prometheus.svg",
    blurb:
      "Connect the Prometheus you already run so investigations can query your metrics. Read-only, and works with zero runners installed.",
    cardDescription:
      "Query your metrics to confirm a symptom and chart what backs it.",
    queryPlaceholder: "http://prometheus.internal:9090",
    queryHelp:
      "The base URL of your Prometheus. NightWarden connects from its own machine, so the address has to work from there, not from this browser.",
    rulesPlaceholder: "http://prometheus.internal:9090",
    rulesHelp: `Prometheus serves its own alerting rules, so this is normally the same URL. ${RULES_WHY}`,
    authHelp:
      "Only if your Prometheus sits behind auth. Stored encrypted and sent as-is.",
    warnings: [],
  },
  victoriametrics: {
    label: "VictoriaMetrics",
    logo: "/logos/victoriametrics.svg",
    blurb:
      "Connect VictoriaMetrics, single-node or cluster. Queries go to vmsingle or vmselect; alerting rules live in vmalert, which is a separate address.",
    cardDescription:
      "Query VictoriaMetrics, single-node or cluster, and read vmalert's rules.",
    queryPlaceholder: "http://vmselect:8481/select/0/prometheus",
    queryHelp:
      "vmsingle's base URL, or for a cluster the vmselect address including the tenant prefix, such as /select/0/prometheus.",
    rulesPlaceholder: "http://vmalert:8880",
    rulesHelp: `vmalert's address. vmsingle and vmselect do not serve alerting rules at all, so this cannot be the same URL as above. ${RULES_WHY}`,
    authHelp:
      "VictoriaMetrics has no auth of its own, so this is whatever vmauth or your proxy expects. Stored encrypted and sent as-is.",
    warnings: [
      "VictoriaMetrics does not implement the metric metadata API. It answers with an empty result for every metric, so investigations read a metric's type from its behaviour instead of asking.",
    ],
  },
  mimir: {
    label: "Grafana Mimir",
    logo: "/logos/grafana.svg",
    blurb:
      "Connect Grafana Mimir, self-hosted or as Grafana Cloud Metrics, which is the same thing hosted by Grafana Labs.",
    cardDescription:
      "Query Grafana Mimir, self-hosted or as Grafana Cloud Metrics.",
    queryPlaceholder: "http://mimir:8080/prometheus",
    queryHelp:
      "Include Mimir's Prometheus prefix, /prometheus by default. On Grafana Cloud this is the query endpoint from the Prometheus card in your Cloud Portal, which ends in /api/prom.",
    rulesPlaceholder: "http://mimir-ruler:8080/prometheus",
    rulesHelp: `Mimir's ruler, which is a separate service in microservices mode. On Grafana Cloud rules live on your Grafana stack instead, at /api/prometheus/grafanacloud-prom, behind a Grafana service account token rather than the metrics credential. ${RULES_WHY}`,
    authHelp:
      "On Grafana Cloud use the username and password fields: the username is your metrics instance ID and the password an access policy token. Self-hosted Mimir usually wants a tenant instead, or both.",
    warnings: [
      "Mimir needs the tenant header when multi-tenancy is on. Leave it empty only if you have turned multi-tenancy off.",
    ],
  },
  thanos: {
    label: "Thanos",
    logo: "/logos/thanos.svg",
    blurb:
      "Connect Thanos Query, which answers for every Prometheus behind it and aggregates alerting rules from your rulers and sidecars.",
    cardDescription:
      "Query Thanos and read the rules it aggregates from your rulers.",
    queryPlaceholder: "http://thanos-query:9090",
    queryHelp:
      "Thanos Query's address, including any --web.route-prefix you have set.",
    rulesPlaceholder: "http://thanos-query:9090",
    rulesHelp: `Thanos Query serves aggregated rules itself, so this is normally the same URL. ${RULES_WHY}`,
    authHelp:
      "Thanos has no auth of its own, so this is whatever your proxy expects. Stored encrypted and sent as-is.",
    warnings: [],
  },
};
