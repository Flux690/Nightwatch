import { describeNetworkFailure } from "./reachability.js";
export type LokiErrorCode =
  "network" | "unauthorized" | "bad_query" | "bad_response";

export class LokiApiError extends Error {
  constructor(
    readonly code: LokiErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LokiApiError";
  }
}

// One stream per labelset; values are [nanosecond-timestamp-string, line] as
// Loki returns them, normalized no further here so the tool owns presentation.
interface LokiStream {
  labels: Record<string, string>;
  values: Array<[string, string]>;
}

interface LokiLogData {
  streams: LokiStream[];
}

// Metric-style LogQL (rate/count) returns a matrix, shaped like Prometheus so
// the log-metrics tool can reuse the same series-capping logic.
export interface LokiMetricSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface LokiMetricData {
  resultType: string;
  series: LokiMetricSeries[];
}

// No per-request timeout param exists on Loki's query API (unlike Prometheus), so
// bound the fetch here, kept under the tools' 30s budget so Loki gives up first.
const FETCH_TIMEOUT_MS = 28_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Loki windows are nanosecond epochs; ms*1e6 overflows a JS number, so go via
// BigInt to keep the value exact.
function toLokiNs(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

async function lokiFetch(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "nightwarden" };
  if (authHeader !== null) headers["Authorization"] = authHeader;
  // Multi-tenant Loki requires this header on every request; single-binary Loki
  // ignores it, so sending it when configured is always safe.
  if (orgId !== null) headers["X-Scope-OrgID"] = orgId;
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, path), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Queries POST as form bodies: LogQL can exceed URL limits, and label
      // values stay out of access logs (same posture as Prometheus).
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
    throw new LokiApiError("network", 0, describeNetworkFailure(err, "Loki"));
  }
  if (res.status === 401 || res.status === 403) {
    throw new LokiApiError(
      "unauthorized",
      res.status,
      "Loki rejected the credential (check the token and the tenant / X-Scope-OrgID)",
    );
  }
  return res;
}

// Loki reports a bad LogQL query as HTTP 400 with a plain-text body (no JSON
// error envelope like Prometheus), so surface that text as the agent-visible
// message; everything else degrades into a typed bad_response.
async function readData(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 400) {
      throw new LokiApiError(
        "bad_query",
        400,
        text || "Loki rejected the query",
      );
    }
    throw new LokiApiError(
      "bad_response",
      res.status,
      `Loki returned ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LokiApiError(
      "bad_response",
      res.status,
      `Loki returned a non-JSON body (HTTP ${res.status}) - is this URL a Loki API endpoint?`,
    );
  }
  if (body["status"] !== "success") {
    throw new LokiApiError(
      "bad_response",
      res.status,
      "Loki returned without a success envelope",
    );
  }
  return body["data"];
}

function narrowLabels(raw: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") labels[k] = v;
    }
  }
  return labels;
}

function narrowStream(entry: unknown): LokiStream {
  const e = (entry ?? {}) as Record<string, unknown>;
  const values = Array.isArray(e["values"]) ? e["values"] : [];
  return {
    labels: narrowLabels(e["stream"]),
    values: values.flatMap((pair): Array<[string, string]> => {
      if (!Array.isArray(pair)) return [];
      const [ts, line] = pair as [unknown, unknown];
      return typeof ts === "string" && typeof line === "string"
        ? [[ts, line]]
        : [];
    }),
  };
}

function narrowMetricSeries(entry: unknown): LokiMetricSeries {
  const e = (entry ?? {}) as Record<string, unknown>;
  const values = Array.isArray(e["values"]) ? e["values"] : [];
  return {
    metric: narrowLabels(e["metric"]),
    values: values.flatMap((pair): Array<[number, string]> => {
      if (!Array.isArray(pair)) return [];
      const [t, v] = pair as [unknown, unknown];
      return typeof t === "number" && typeof v === "string" ? [[t, v]] : [];
    }),
  };
}

export async function queryLogRange(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  query: string,
  start: Date,
  end: Date,
  limit: number,
): Promise<LokiLogData> {
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    "/loki/api/v1/query_range",
    {
      query,
      start: toLokiNs(start),
      end: toLokiNs(end),
      limit: String(limit),
      direction: "backward",
    },
  );
  const data = (await readData(res)) as Record<string, unknown> | undefined;
  const raw = Array.isArray(data?.["result"]) ? data["result"] : [];
  return { streams: raw.map(narrowStream) };
}

export async function queryMetricRange(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  query: string,
  start: Date,
  end: Date,
  stepSeconds: number,
): Promise<LokiMetricData> {
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    "/loki/api/v1/query_range",
    {
      query,
      start: toLokiNs(start),
      end: toLokiNs(end),
      step: String(stepSeconds),
    },
  );
  const data = (await readData(res)) as Record<string, unknown> | undefined;
  const resultType =
    typeof data?.["resultType"] === "string" ? data["resultType"] : "";
  const raw = Array.isArray(data?.["result"]) ? data["result"] : [];
  return { resultType, series: raw.map(narrowMetricSeries) };
}

function stringList(data: unknown): string[] {
  return Array.isArray(data)
    ? data.filter((v): v is string => typeof v === "string")
    : [];
}

// GET (no secrets in the path): a window bounds discovery to labels seen around
// the incident. Loki does the filtering; we only pass the range.
export async function labelNames(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  start: Date,
  end: Date,
): Promise<string[]> {
  const qs = new URLSearchParams({
    start: toLokiNs(start),
    end: toLokiNs(end),
  });
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    `/loki/api/v1/labels?${qs.toString()}`,
  );
  return stringList(await readData(res));
}

export async function labelValues(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  label: string,
  start: Date,
  end: Date,
): Promise<string[]> {
  const qs = new URLSearchParams({
    start: toLokiNs(start),
    end: toLokiNs(end),
  });
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    `/loki/api/v1/label/${encodeURIComponent(label)}/values?${qs.toString()}`,
  );
  return stringList(await readData(res));
}

// Returns the label sets of streams matching a selector - lets the agent narrow
// discovery once it knows one label (e.g. match[]={namespace="shop"}).
export async function series(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  selector: string,
  start: Date,
  end: Date,
): Promise<Array<Record<string, string>>> {
  const qs = new URLSearchParams({
    "match[]": selector,
    start: toLokiNs(start),
    end: toLokiNs(end),
  });
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    `/loki/api/v1/series?${qs.toString()}`,
  );
  const data = await readData(res);
  return Array.isArray(data) ? data.map(narrowLabels) : [];
}

// Cheap, auth- and tenant-exercising probe used wherever a Loki connection is
// established: a recent-window label listing proves the URL, credential, and
// X-Scope-OrgID all work and that discovery will function.
export async function probeLoki(
  url: string,
  authHeader: string | null,
  orgId: string | null,
): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  await labelNames(url, authHeader, orgId, start, end);
}
