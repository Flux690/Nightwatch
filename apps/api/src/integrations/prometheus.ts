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
