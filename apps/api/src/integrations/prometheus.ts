import { describeNetworkFailure } from "./reachability.js";
export type PrometheusErrorCode =
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
export interface FiringInstance {
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
  const res = await prometheusFetch(
    baseUrl,
    authHeader,
    `/api/v1/rules?type=alert&rule_name[]=${encodeURIComponent(ruleName)}`,
  );
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned a non-JSON body (HTTP ${res.status}) listing rules`,
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned ${res.status} listing rules`,
    );
  }
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

export async function labelValues(
  baseUrl: string,
  authHeader: string | null,
  label: string,
): Promise<string[]> {
  const res = await prometheusFetch(
    baseUrl,
    authHeader,
    `/api/v1/label/${encodeURIComponent(label)}/values`,
  );
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned a non-JSON body (HTTP ${res.status})`,
    );
  }
  if (!res.ok || body["status"] !== "success") {
    throw new PrometheusApiError(
      "bad_response",
      res.status,
      `Prometheus returned ${res.status} listing label values`,
    );
  }
  const data = body["data"];
  return Array.isArray(data)
    ? data.filter((v): v is string => typeof v === "string")
    : [];
}
