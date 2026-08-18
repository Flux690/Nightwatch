import type { MetricsErrorCode } from "@nightwarden/shared";
import { describeNetworkFailure } from "../reachability.js";

/* The Prometheus HTTP API, and nothing else. Every source we support speaks
   it, so there is one client here and no per-product adapter; what varies is
   the endpoint it is handed. */

export class MetricsApiError extends Error {
  constructor(
    readonly code: MetricsErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MetricsApiError";
  }
}

/* One address the API dials, with its credential already resolved. `name` is
   the product's own, used only in error text so a failure names the thing the
   user configured rather than "the metrics source". */
export interface MetricsEndpoint {
  url: string;
  authorization: string | null;
  orgId: string | null;
  name: string;
}

// One series per labelset; instant results are normalized to a single-entry
// values array so the tools handle vector and matrix results identically.
export interface MetricsSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface MetricsQueryData {
  resultType: string;
  series: MetricsSeries[];
}

// Server-side evaluation cap, kept under the tools' 30s budget so the source
// gives up before the tool timeout turns the failure opaque.
const QUERY_TIMEOUT = "25s";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Queries go as POST form bodies: PromQL can exceed URL limits, and label
// values stay out of access logs (same posture as tokens-never-in-URLs).
async function metricsFetch(
  endpoint: MetricsEndpoint,
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "nightwarden" };
  if (endpoint.authorization !== null) {
    headers["Authorization"] = endpoint.authorization;
  }
  // Mimir requires a tenant whenever multi-tenancy is on and ignores it when
  // off, so sending it where one is configured is always safe.
  if (endpoint.orgId !== null) headers["X-Scope-OrgID"] = endpoint.orgId;
  let res: Response;
  try {
    res = await fetch(joinUrl(endpoint.url, path), {
      headers:
        form === undefined
          ? headers
          : { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      ...(form !== undefined && {
        method: "POST",
        body: new URLSearchParams(form).toString(),
      }),
    });
  } catch (err) {
    throw new MetricsApiError(
      "network",
      0,
      describeNetworkFailure(err, endpoint.name),
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new MetricsApiError(
      "unauthorized",
      res.status,
      `${endpoint.name} rejected the credential`,
    );
  }
  return res;
}

// The envelope is narrowed field-by-field so a drifted payload degrades into
// a typed error, never a crash mid-investigation.
async function parseEnvelope(
  endpoint: MetricsEndpoint,
  res: Response,
): Promise<MetricsQueryData> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned a non-JSON body (HTTP ${res.status}) - is this URL a Prometheus-compatible API endpoint?`,
    );
  }
  if (body["status"] === "error") {
    throw new MetricsApiError(
      "bad_query",
      res.status,
      typeof body["error"] === "string" ? body["error"] : "query failed",
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} without a success envelope`,
    );
  }
  const data = body["data"] as Record<string, unknown> | undefined;
  const resultType =
    typeof data?.["resultType"] === "string" ? data["resultType"] : "";
  const raw = Array.isArray(data?.["result"]) ? data["result"] : [];
  return { resultType, series: raw.map(narrowSeries) };
}

// The success envelope every non-query endpoint answers with. `what` names the
// call so a drifted payload says which read failed rather than only that one did.
async function jsonBody(
  endpoint: MetricsEndpoint,
  res: Response,
  what: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned a non-JSON body (HTTP ${res.status}) ${what}`,
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} ${what}`,
    );
  }
  return body;
}

function narrowSeries(entry: unknown): MetricsSeries {
  const e = (entry ?? {}) as Record<string, unknown>;
  const metric: Record<string, string> = {};
  if (typeof e["metric"] === "object" && e["metric"] !== null) {
    for (const [k, v] of Object.entries(e["metric"])) {
      if (typeof v === "string") metric[k] = v;
    }
  }
  const values = Array.isArray(e["values"])
    ? e["values"]
    : Array.isArray(e["value"])
      ? [e["value"]]
      : [];
  return {
    metric,
    values: values.flatMap((pair): Array<[number, string]> => {
      if (!Array.isArray(pair)) return [];
      const [t, v] = pair as [unknown, unknown];
      return typeof t === "number" && typeof v === "string" ? [[t, v]] : [];
    }),
  };
}

export async function instantQuery(
  endpoint: MetricsEndpoint,
  query: string,
  timeIso?: string,
): Promise<MetricsQueryData> {
  const res = await metricsFetch(endpoint, "/api/v1/query", {
    query,
    timeout: QUERY_TIMEOUT,
    ...(timeIso !== undefined && { time: timeIso }),
  });
  return parseEnvelope(endpoint, res);
}

export async function rangeQuery(
  endpoint: MetricsEndpoint,
  query: string,
  startIso: string,
  endIso: string,
  stepSeconds: number,
): Promise<MetricsQueryData> {
  const res = await metricsFetch(endpoint, "/api/v1/query_range", {
    query,
    start: startIso,
    end: endIso,
    step: String(stepSeconds),
    timeout: QUERY_TIMEOUT,
  });
  return parseEnvelope(endpoint, res);
}

// One currently-active instance of an alerting rule, as the source itself sees
// it. The labels identify which instance, since one rule fires per series.
interface FiringInstance {
  labels: Record<string, string>;
  state: string;
}

/* Asks the rules API rather than re-evaluating ourselves: this is the same rule
   on the same interval that fired the alert. `null` means no rule by that name -
   renamed, removed, or from elsewhere - which is not "it is not firing". */
export async function firingInstancesOf(
  endpoint: MetricsEndpoint,
  ruleName: string,
): Promise<FiringInstance[] | null> {
  const body = await jsonBody(
    endpoint,
    await metricsFetch(
      endpoint,
      `/api/v1/rules?type=alert&rule_name[]=${encodeURIComponent(ruleName)}`,
    ),
    "listing rules",
  );
  const groups = (body["data"] as Record<string, unknown> | undefined)?.[
    "groups"
  ];
  if (!Array.isArray(groups)) return null;

  const rules = groups.flatMap((group) => {
    const list = (group as Record<string, unknown>)["rules"];
    return Array.isArray(list) ? list : [];
  });
  /* The filter is a server-side hint, not a guarantee: an older Prometheus
     ignores rule_name[], and vmalert documents no support for it at all. */
  const named = rules.filter(
    (rule) => (rule as Record<string, unknown>)["name"] === ruleName,
  );
  if (named.length === 0) return null;

  return named.flatMap((rule) => {
    const alerts = (rule as Record<string, unknown>)["alerts"];
    if (!Array.isArray(alerts)) return [];
    return alerts.flatMap((entry): FiringInstance[] => {
      const alert = entry as Record<string, unknown>;
      const state = alert["state"];
      if (typeof state !== "string") return [];
      const labels: Record<string, string> = {};
      if (typeof alert["labels"] === "object" && alert["labels"] !== null) {
        for (const [k, v] of Object.entries(alert["labels"])) {
          if (typeof v === "string") labels[k] = v;
        }
      }
      return [{ labels, state }];
    });
  });
}

// One alerting rule as the source holds it: the expression it evaluates and
// whether it is currently firing.
export interface AlertingRule {
  name: string;
  query: string;
  state: string;
  firingCount: number;
}

export async function alertingRules(
  endpoint: MetricsEndpoint,
): Promise<AlertingRule[]> {
  const body = await jsonBody(
    endpoint,
    await metricsFetch(endpoint, "/api/v1/rules?type=alert"),
    "listing rules",
  );
  const groups = (body["data"] as Record<string, unknown> | undefined)?.[
    "groups"
  ];
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => {
      const list = (group as Record<string, unknown>)["rules"];
      return Array.isArray(list) ? list : [];
    })
    .flatMap((entry): AlertingRule[] => {
      const rule = entry as Record<string, unknown>;
      const name = rule["name"];
      const query = rule["query"];
      if (typeof name !== "string" || typeof query !== "string") return [];
      const alerts = Array.isArray(rule["alerts"]) ? rule["alerts"] : [];
      return [
        {
          name,
          query,
          state: typeof rule["state"] === "string" ? rule["state"] : "unknown",
          firingCount: alerts.length,
        },
      ];
    });
}

// The names the source is currently storing, optionally narrowed by substring.
// Matched here rather than server-side: /label/__name__/values takes no filter.
export async function metricNames(
  endpoint: MetricsEndpoint,
  contains: string | null,
): Promise<string[]> {
  const body = await jsonBody(
    endpoint,
    await metricsFetch(endpoint, "/api/v1/label/__name__/values"),
    "listing metric names",
  );
  const data = body["data"];
  const all = Array.isArray(data)
    ? data.filter((v): v is string => typeof v === "string")
    : [];
  if (contains === null) return all;
  const needle = contains.toLowerCase();
  return all.filter((name) => name.toLowerCase().includes(needle));
}

// What a metric is and what it is measured in. Only known for metrics an
// exporter declared with HELP and TYPE, and some sources store none at all.
export interface MetricMetadata {
  metric: string;
  type: string;
  unit: string;
  help: string;
}

export async function metricMetadata(
  endpoint: MetricsEndpoint,
  metric: string,
): Promise<MetricMetadata | null> {
  const body = await jsonBody(
    endpoint,
    await metricsFetch(
      endpoint,
      `/api/v1/metadata?metric=${encodeURIComponent(metric)}`,
    ),
    "reading metric metadata",
  );
  const data = body["data"];
  if (typeof data !== "object" || data === null) return null;
  const entries = (data as Record<string, unknown>)[metric];
  const first = Array.isArray(entries) ? entries[0] : undefined;
  if (typeof first !== "object" || first === null) return null;
  const row = first as Record<string, unknown>;
  return {
    metric,
    type: typeof row["type"] === "string" ? row["type"] : "unknown",
    unit: typeof row["unit"] === "string" ? row["unit"] : "",
    help: typeof row["help"] === "string" ? row["help"] : "",
  };
}
