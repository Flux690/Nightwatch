import { z } from "zod";
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
  signal: AbortSignal,
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
      signal,
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

// Loki reports a bad LogQL query as a 400 with a plain-text body rather than
// Prometheus's JSON envelope, so that text becomes the agent-visible message.
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
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LokiApiError(
      "bad_response",
      res.status,
      `Loki returned a non-JSON body (HTTP ${res.status}) - is this URL a Loki API endpoint?`,
    );
  }
  const envelope = parse(ENVELOPE, body, res.status, "a query");
  if (envelope.status !== "success") {
    throw new LokiApiError(
      "bad_response",
      res.status,
      "Loki returned without a success envelope",
    );
  }
  return envelope.data;
}

const LABELS = z.record(z.string(), z.string());

/* Shapes from Loki's own HTTP API reference. Unknown keys pass through, since
   an addition is the only change it makes; a rename fails loudly instead. */
const ENVELOPE = z.looseObject({
  status: z.string(),
  data: z.unknown(),
});

const STREAM_DATA = z.looseObject({
  resultType: z.literal("streams"),
  result: z.array(
    z.looseObject({
      stream: LABELS,
      // Nanosecond epochs, which Loki sends as strings because they overflow.
      values: z.array(z.tuple([z.string(), z.string()])),
    }),
  ),
});

const METRIC_DATA = z.looseObject({
  resultType: z.literal("matrix"),
  result: z.array(
    z.looseObject({
      metric: LABELS,
      values: z.array(z.tuple([z.number(), z.string()])),
    }),
  ),
});

// The one field name a caller can act on, so a drift says which it was.
function fieldPath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined || issue.path.length === 0
    ? "the response body"
    : issue.path.join(".");
}

/* Parsed rather than narrowed field by field: a shape we cannot read is a
   failure the agent must see, never an empty result it would read as a finding. */
function parse<T>(
  schema: z.ZodType<T>,
  body: unknown,
  status: number,
  what: string,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new LokiApiError(
    "bad_response",
    status,
    `Loki answered ${what} in a shape this cannot read: ${fieldPath(parsed.error)} is wrong. Nothing was read, so treat this as unknown rather than as an absence.`,
  );
}

export async function queryLogRange(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
  query: string,
  start: Date,
  end: Date,
  limit: number,
): Promise<LokiLogData> {
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    signal,
    "/loki/api/v1/query_range",
    {
      query,
      start: toLokiNs(start),
      end: toLokiNs(end),
      limit: String(limit),
      direction: "backward",
    },
  );
  const data = parse(STREAM_DATA, await readData(res), res.status, "log lines");
  return {
    streams: data.result.map((entry) => ({
      labels: entry.stream,
      values: entry.values,
    })),
  };
}

export async function queryMetricRange(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
  query: string,
  start: Date,
  end: Date,
  stepSeconds: number,
): Promise<LokiMetricData> {
  const res = await lokiFetch(
    baseUrl,
    authHeader,
    orgId,
    signal,
    "/loki/api/v1/query_range",
    {
      query,
      start: toLokiNs(start),
      end: toLokiNs(end),
      step: String(stepSeconds),
    },
  );
  const data = parse(
    METRIC_DATA,
    await readData(res),
    res.status,
    "log metrics",
  );
  return {
    resultType: data.resultType,
    series: data.result.map((entry) => ({
      metric: entry.metric,
      values: entry.values,
    })),
  };
}

/* Loki omits `data` entirely when a window holds no labels, which is an empty
   listing rather than a shape it failed to send. */
const STRING_LIST = z.array(z.string()).nullish();

// GET (no secrets in the path): a window bounds discovery to labels seen around
// the incident. Loki does the filtering; we only pass the range.
export async function labelNames(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
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
    signal,
    `/loki/api/v1/labels?${qs.toString()}`,
  );
  const data = parse(
    STRING_LIST,
    await readData(res),
    res.status,
    "label names",
  );
  return data ?? [];
}

export async function labelValues(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
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
    signal,
    `/loki/api/v1/label/${encodeURIComponent(label)}/values?${qs.toString()}`,
  );
  const data = parse(
    STRING_LIST,
    await readData(res),
    res.status,
    "label values",
  );
  return data ?? [];
}

// The label sets of streams matching a selector, so the agent can narrow
// discovery once it knows one label (e.g. match[]={namespace="shop"}).
export async function series(
  baseUrl: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
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
    signal,
    `/loki/api/v1/series?${qs.toString()}`,
  );
  const data = parse(
    z.array(LABELS).nullish(),
    await readData(res),
    res.status,
    "matching streams",
  );
  return data ?? [];
}

// A recent-window label listing proves the URL, the credential and the
// X-Scope-OrgID all work, and that discovery will function.
export async function probeLoki(
  url: string,
  authHeader: string | null,
  orgId: string | null,
  signal: AbortSignal,
): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  await labelNames(url, authHeader, orgId, signal, start, end);
}
