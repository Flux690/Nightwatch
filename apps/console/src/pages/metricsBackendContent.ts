import type { MetricsBackendKind } from "@nightwarden/shared";

/* Only text differs between backends. Connecting, probing and disconnecting are
   one code path serving every kind, the way the alert sources are. What is
   worth saying per product is where the rules live and what breaks quietly. */
export interface MetricsBackendContent {
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
  "Without it an investigation can never confirm the alert stopped firing.";

export const METRICS_BACKEND_CONTENT: Record<
  MetricsBackendKind,
  MetricsBackendContent
> = {
  prometheus: {
    queryPlaceholder: "http://prometheus.internal:9090",
    queryHelp:
      "NightWarden dials this from its own machine, so it must be reachable from there.",
    rulesPlaceholder: "http://prometheus.internal:9090",
    rulesHelp: `Prometheus serves its own alerting rules, so this is normally the same URL. ${RULES_WHY}`,
    authHelp: "Add this only if your Prometheus sits behind authentication.",
    warnings: [],
  },
  victoriametrics: {
    queryPlaceholder: "http://vmselect:8481/select/0/prometheus",
    queryHelp: "Use vmsingle's URL, or vmselect's including its tenant prefix.",
    rulesPlaceholder: "http://vmalert:8880",
    rulesHelp: `Only vmalert serves alerting rules, so this cannot be the URL above. ${RULES_WHY}`,
    authHelp:
      "VictoriaMetrics has no auth of its own, so this is whatever vmauth expects.",
    warnings: [
      "VictoriaMetrics does not implement the metric metadata API. It answers with an empty result for every metric, so investigations read a metric's type from its behaviour instead of asking.",
    ],
  },
  mimir: {
    queryPlaceholder: "http://mimir:8080/prometheus",
    queryHelp:
      "Include Mimir's Prometheus prefix, which is /prometheus by default.",
    rulesPlaceholder: "http://mimir-ruler:8080/prometheus",
    rulesHelp: `Mimir's ruler is a separate service, and on Grafana Cloud it is your Grafana stack. ${RULES_WHY}`,
    authHelp:
      "Grafana Cloud uses the username and password fields below, not this one.",
    warnings: [
      "Mimir needs the tenant header when multi-tenancy is on. Leave it empty only if you have turned multi-tenancy off.",
    ],
  },
  thanos: {
    queryPlaceholder: "http://thanos-query:9090",
    queryHelp:
      "Use Thanos Query's address, including any route prefix you have set.",
    rulesPlaceholder: "http://thanos-query:9090",
    rulesHelp: `Thanos Query serves aggregated rules itself, so this is normally the same URL. ${RULES_WHY}`,
    authHelp:
      "Thanos has no auth of its own, so this is whatever your proxy expects.",
    warnings: [],
  },
};
