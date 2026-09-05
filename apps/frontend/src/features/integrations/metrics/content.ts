/* Only text and which fields apply differ between sources. Connecting, probing
   and disconnecting are one code path serving every kind. */

import type { MetricsSourceKind } from "@nightwarden/shared";

/* One credential reaches the source, never two: the API keeps the header and
   discards the basic pair, so offering both would promise what never happens. */
export type AuthMethod = "none" | "bearer" | "basic" | "aws";

export const AUTH_LABEL: Record<AuthMethod, string> = {
  none: "None",
  bearer: "Bearer token",
  basic: "Username and password",
  aws: "AWS credentials",
};

export interface MetricsSourceContent {
  queryPlaceholder: string;
  // Only what is true of this product. What is true of every one of them is
  // said once, by the section the field sits in.
  queryHelp: string;
  rulesPlaceholder: string;
  rulesHelp: string;
  // What this product actually hands people. The first is the default, and a
  // single entry is not a choice, so no control is drawn for it.
  auth: AuthMethod[];
  // Empty where the picker's own options already say everything there is.
  authHelp: string;
  // Mimir alone reads X-Scope-OrgID. VictoriaMetrics carries its tenant in the
  // URL path, which is why its placeholder already has one.
  tenant: boolean;
  warnings: string[];
}

/* What each section is for, in one line, so no field has to carry the general
   case as well as its own. */
export const QUERY_LEAD =
  "Where NightWarden reads metrics from. It dials this from its own machine, so the address has to be reachable from there.";

export const RULES_LEAD =
  "How an investigation confirms the alert cleared, by asking whether the rule that fired still holds. Leave it empty and the only way it can reach Resolved is your alert source sending a resolved notification.";

export const METRICS_SOURCE_CONTENT: Record<
  MetricsSourceKind,
  MetricsSourceContent
> = {
  prometheus: {
    queryPlaceholder: "http://prometheus.internal:9090",
    queryHelp: "",
    rulesPlaceholder: "http://prometheus.internal:9090",
    rulesHelp:
      "Prometheus serves its own rules, so this is normally the same address.",
    auth: ["none", "bearer", "basic"],
    authHelp: "",
    tenant: false,
    warnings: [],
  },
  victoriametrics: {
    queryPlaceholder: "http://vmselect:8481/select/0/prometheus",
    queryHelp: "vmsingle's address, or vmselect's including its tenant prefix.",
    rulesPlaceholder: "http://vmalert:8880",
    rulesHelp:
      "Only vmalert serves rules, so this cannot be the address above.",
    auth: ["none", "bearer", "basic"],
    authHelp:
      "VictoriaMetrics has none of its own; this is what vmauth expects.",
    tenant: false,
    warnings: [
      "Metric metadata needs -enableMetadata on your VictoriaMetrics, and v1.130.0 or newer. Without it the metadata endpoint answers empty for every metric, so investigations read a metric's type from its behaviour instead of asking.",
    ],
  },
  mimir: {
    queryPlaceholder: "http://mimir:8080/prometheus",
    queryHelp: "Mimir's query endpoint, including its /prometheus prefix.",
    rulesPlaceholder: "http://mimir-ruler:8080/prometheus",
    rulesHelp:
      "Mimir's ruler, which is a separate service - on Grafana Cloud, your Grafana stack.",
    auth: ["basic", "bearer", "none"],
    authHelp:
      "Grafana Cloud uses your instance ID as the username and an access policy token as the password.",
    tenant: true,
    warnings: [],
  },
  thanos: {
    queryPlaceholder: "http://thanos-query:9090",
    queryHelp: "Thanos Query's address, including any route prefix you set.",
    rulesPlaceholder: "http://thanos-query:9090",
    rulesHelp:
      "Thanos Query serves the aggregated rules itself, so this is normally the address above.",
    auth: ["none", "bearer", "basic"],
    authHelp: "Thanos has none of its own; this is what your proxy expects.",
    tenant: false,
    warnings: [],
  },
  amp: {
    queryPlaceholder:
      "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-.../",
    queryHelp: "Your workspace's query endpoint.",
    rulesPlaceholder:
      "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-.../",
    rulesHelp: "Usually the same workspace endpoint.",
    auth: ["aws"],
    authHelp: "An IAM user or role with query access to this workspace.",
    tenant: false,
    warnings: [],
  },
};
