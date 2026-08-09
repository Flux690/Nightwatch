import { describeNetworkFailure } from "./reachability.js";
type PrometheusErrorCode =
  "network" | "unauthorized" | "bad_query" | "bad_response";

export class PrometheusApiError extends Error {
  constructor(
    readonly code: PrometheusErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PrometheusApiError";
  }
}

// One series per labelset; instant results are normalized to a single-entry
// values array so the tools handle vector and matrix results identically.
export interface PrometheusSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface PrometheusQueryData {
  resultType: string;
  series: PrometheusSeries[];
}

// Server-side evaluation cap, kept under the tools' 30s budget so Prometheus
// gives up before the tool timeout turns the failure opaque.
const QUERY_TIMEOUT = "25s";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Queries go as POST form bodies: PromQL can exceed URL limits, and label
// values stay out of access logs (same posture as tokens-never-in-URLs).
async function prometheusFetch(
  baseUrl: string,
  authHeader: string | null,
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "nightwarden" };
  if (authHeader !== null) headers["Authorization"] = authHeader;
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, path), {
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
    throw new PrometheusApiError(
      "network",
      0,
      describeNetworkFailure(err, "Prometheus"),
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new PrometheusApiError(
      "unauthorized",
      res.status,
      "Prometheus rejected the credential",
    );
  }
  return res;
}

// The envelope is narrowed field-by-field so a drifted payload degrades into
// a typed error, never a crash mid-investigation.
async function parseEnvelope(res: Response): Promise<PrometheusQueryData> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned a non-JSON body (HTTP ${res.status}) - is this URL a Prometheus API endpoint?`,
    );
  }
  if (body["status"] === "error") {
    throw new PrometheusApiError(
      "bad_query",
      res.status,
      typeof body["error"] === "string" ? body["error"] : "query failed",
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned ${res.status} without a success envelope`,
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
  res: Response,
  what: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned a non-JSON body (HTTP ${res.status}) ${what}`,
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned ${res.status} ${what}`,
    );
  }
  return body;
}

function narrowSeries(entry: unknown): PrometheusSeries {
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
  baseUrl: string,
  authHeader: string | null,
  query: string,
  timeIso?: string,
): Promise<PrometheusQueryData> {
  const res = await prometheusFetch(baseUrl, authHeader, "/api/v1/query", {
    query,
    timeout: QUERY_TIMEOUT,
    ...(timeIso !== undefined && { time: timeIso }),
  });
  return parseEnvelope(res);
}

export async function rangeQuery(
  baseUrl: string,
  authHeader: string | null,
  query: string,
  startIso: string,
  endIso: string,
  stepSeconds: number,
): Promise<PrometheusQueryData> {
  const res = await prometheusFetch(
    baseUrl,
    authHeader,
    "/api/v1/query_range",
    {
      query,
      start: startIso,
      end: endIso,
      step: String(stepSeconds),
      timeout: QUERY_TIMEOUT,
    },
  );
  return parseEnvelope(res);
}

// One currently-active instance of an alerting rule, as Prometheus itself sees
// it. The labels identify which instance, since one rule fires per series.
interface FiringInstance {
  labels: Record<string, string>;
  state: string;
}

/* Whether Prometheus still holds this alerting rule firing. Asking the rules API
   rather than re-evaluating the expression ourselves: this is the same rule, on
   the same evaluation interval, that fired the alert in the first place, so
   nothing here can disagree with what would fire it again.

   `null` means Prometheus does not know a rule by that name - it was renamed,
   removed, or the alert came from somewhere else - which is a different answer
   from "it is not firing" and must not be read as recovery. */
export async function firingInstancesOf(
  baseUrl: string,
  authHeader: string | null,
  ruleName: string,
): Promise<FiringInstance[] | null> {
  const body = await jsonBody(
    await prometheusFetch(
      baseUrl,
      authHeader,
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
  // The filter is a server-side hint, not a guarantee: an older Prometheus
  // ignores rule_name[] and answers with everything.
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

// One alerting rule as Prometheus holds it: the expression it evaluates and
// whether it is currently firing.
export interface AlertingRule {
  name: string;
  query: string;
  state: string;
  firingCount: number;
}

export async function alertingRules(
  baseUrl: string,
  authHeader: string | null,
): Promise<AlertingRule[]> {
  const body = await jsonBody(
    await prometheusFetch(baseUrl, authHeader, "/api/v1/rules?type=alert"),
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

// The names Prometheus is currently storing, optionally narrowed by substring.
// Matched here rather than server-side: /label/__name__/values takes no filter.
export async function metricNames(
  baseUrl: string,
  authHeader: string | null,
  contains: string | null,
): Promise<string[]> {
  const body = await jsonBody(
    await prometheusFetch(baseUrl, authHeader, "/api/v1/label/__name__/values"),
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

// What a metric is and what it is measured in. Prometheus only knows this for
// metrics an exporter declared with HELP and TYPE, so an answer is often empty.
interface MetricMetadata {
  metric: string;
  type: string;
  unit: string;
  help: string;
}

export async function metricMetadata(
  baseUrl: string,
  authHeader: string | null,
  metric: string,
): Promise<MetricMetadata | null> {
  const body = await jsonBody(
    await prometheusFetch(
      baseUrl,
      authHeader,
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
