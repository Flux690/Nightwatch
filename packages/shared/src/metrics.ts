/* Every metrics source speaks the Prometheus HTTP API, so there is one client
   and no per-product adapter. What differs is configuration: where the rules
   live, how the credential is presented, and what the source cannot answer. */

export const METRICS_SOURCE_KINDS = [
  "prometheus",
  "victoriametrics",
  "mimir",
  "thanos",
] as const;

export type MetricsSourceKind = (typeof METRICS_SOURCE_KINDS)[number];

export function isMetricsSourceKind(value: string): value is MetricsSourceKind {
  return (METRICS_SOURCE_KINDS as readonly string[]).includes(value);
}

/* What the console sends for one endpoint: an Authorization value and a tenant,
   the shape Loki already uses. A basic pair is its own field because Grafana
   Cloud hands out an instance id and a token, never a base64 blob. */
export interface MetricsEndpointInput {
  url: string;
  authHeader?: string;
  basicUsername?: string;
  basicPassword?: string;
  // Sent as X-Scope-OrgID. Mimir requires it whenever multi-tenancy is on and
  // ignores it when off, so sending it where configured is always safe.
  orgId?: string;
}

// Never the credential itself: a status says what is configured, not its value.
export interface MetricsEndpointStatus {
  url: string;
  hasAuth: boolean;
  hasOrgId: boolean;
}

export interface MetricsSourceStatus {
  id: string;
  kind: MetricsSourceKind;
  // What the user called it, and what a tool call names in `metricsSource`.
  label: string;
  query: MetricsEndpointStatus;
  /* Null when no rules endpoint is configured, which the console says out loud.
     Without one an investigation cannot ask whether the alerting rule that
     fired still holds, so it can never confirm recovery by that path. */
  rules: MetricsEndpointStatus | null;
  validatedAt: string;
}

export type MetricsErrorCode =
  "network" | "unauthorized" | "bad_query" | "bad_response";
