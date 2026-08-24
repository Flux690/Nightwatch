// One client, no per-product adapter: what differs is where the rules live,
// how the credential is presented, and what the source cannot answer.

export const METRICS_SOURCE_KINDS = [
  "prometheus",
  "victoriametrics",
  "mimir",
  "thanos",
  "amp",
] as const;

export type MetricsSourceKind = (typeof METRICS_SOURCE_KINDS)[number];

export function isMetricsSourceKind(value: string): value is MetricsSourceKind {
  return (METRICS_SOURCE_KINDS as readonly string[]).includes(value);
}

// AMP signs every request with these instead of a static header.
export interface AmpCredential {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}

/* What the console sends for one endpoint: an Authorization value and a
   tenant, the shape Loki already uses. The four AMP fields apply only when
   kind is "amp". */
export interface MetricsEndpointInput {
  url: string;
  authHeader?: string;
  basicUsername?: string;
  basicPassword?: string;
  // Sent as X-Scope-OrgID. Mimir requires it whenever multi-tenancy is on and
  // ignores it when off, so sending it where configured is always safe.
  orgId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  sessionToken?: string;
}

/* One connect request. A product is connected once, so it is addressed by the
   product's own name and there is nothing here to name it. */
export interface MetricsConnectInput {
  kind: MetricsSourceKind;
  query: MetricsEndpointInput;
  rules?: MetricsEndpointInput;
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
  // The product's own name, and what a tool call names in `metricsSource`.
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
