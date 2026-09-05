import { z } from "zod";
import type { AmpCredential, MetricsErrorCode } from "@nightwarden/shared";
import { describeNetworkFailure } from "../reachability.js";
import { signedRequest } from "./sigv4.js";

/* The Prometheus HTTP API and nothing else. Every source speaks it, so there is
   one client and no per-product adapter; only the endpoint varies. */

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

/* One address the API dials, credential already resolved. `name` appears only in
   error text, so a failure names the product the user configured. */
export interface MetricsEndpoint {
  url: string;
  authorization: string | null;
  orgId: string | null;
  name: string;
  // Set only for AMP: every request is signed with these instead of carrying
  // `authorization`, which stays null when this is set.
  sigv4?: AmpCredential;
}

// One series per labelset; instant results are normalized to a single-entry
// values array so the tools handle vector and matrix results identically.
export interface MetricsSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
  // Set where a point came from a native histogram, whose value is its
  // observation count: a histogram has no single number to plot.
  histogram?: true;
}

export interface MetricsQueryData {
  resultType: string;
  series: MetricsSeries[];
  /* Prometheus and Thanos answer 200 with data and a warning when a store was
     unreachable, so dropping these reports a partial read as a whole one. */
  warnings: string[];
}

const LABELS = z.record(z.string(), z.string());
const FLOAT_POINT = z.tuple([z.number(), z.string()]);
// Only the count is read; buckets and sum ride along untouched.
const HISTOGRAM_POINT = z.tuple([
  z.number(),
  z.looseObject({ count: z.string() }),
]);

const VECTOR_ITEM = z.looseObject({
  metric: LABELS,
  value: FLOAT_POINT.optional(),
  histogram: HISTOGRAM_POINT.optional(),
});

// Prometheus documents a series as carrying values, histograms, or both.
const MATRIX_ITEM = z.looseObject({
  metric: LABELS,
  values: z.array(FLOAT_POINT).optional(),
  histograms: z.array(HISTOGRAM_POINT).optional(),
});

/* Four result types, not two. A scalar's result is a [time, value] pair rather
   than a list, which reads as a list of two series to anything not checking. */
const QUERY_DATA = z.discriminatedUnion("resultType", [
  z.looseObject({
    resultType: z.literal("vector"),
    result: z.array(VECTOR_ITEM),
  }),
  z.looseObject({
    resultType: z.literal("matrix"),
    result: z.array(MATRIX_ITEM),
  }),
  z.looseObject({ resultType: z.literal("scalar"), result: FLOAT_POINT }),
  z.looseObject({ resultType: z.literal("string"), result: FLOAT_POINT }),
]);

/* Unknown keys pass through everywhere: each product adds its own, and an
   addition is the one change these APIs make. A rename fails loudly instead. */
const QUERY_ENVELOPE = z.looseObject({
  status: z.enum(["success", "error"]),
  data: QUERY_DATA.optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

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
  const init: RequestInit = {
    headers:
      form === undefined
        ? headers
        : { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    ...(form !== undefined && {
      method: "POST",
      body: new URLSearchParams(form).toString(),
    }),
  };
  const url = joinUrl(endpoint.url, path);
  let res: Response;
  try {
    res =
      endpoint.sigv4 === undefined
        ? await fetch(url, init)
        : await fetch(await signedRequest(endpoint.sigv4, url, init));
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

// The one field name a caller can act on, so a drift says which it was.
function fieldPath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined || issue.path.length === 0
    ? "the response body"
    : issue.path.join(".");
}

async function readJson(
  endpoint: MetricsEndpoint,
  res: Response,
  what: string,
): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned a non-JSON body (HTTP ${res.status}) ${what} - is this URL a Prometheus-compatible API endpoint?`,
    );
  }
}

/* Parsed rather than narrowed field by field: a shape we cannot read is a
   failure the agent must see, never an empty result it would read as a finding. */
function parse<T>(
  schema: z.ZodType<T>,
  body: unknown,
  endpoint: MetricsEndpoint,
  status: number,
  what: string,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new MetricsApiError(
    "bad_response",
    status,
    `${endpoint.name} answered ${what} in a shape this cannot read: ${fieldPath(parsed.error)} is wrong. Nothing was read, so treat this as unknown rather than as an absence.`,
  );
}

type QueryData = z.infer<typeof QUERY_DATA>;

function seriesOf(data: QueryData): MetricsSeries[] {
  if (data.resultType === "vector") {
    return data.result.map((item) => {
      if (item.value !== undefined) {
        return { metric: item.metric, values: [item.value] };
      }
      if (item.histogram !== undefined) {
        const [at, value] = item.histogram;
        return {
          metric: item.metric,
          values: [[at, value.count] as [number, string]],
          histogram: true as const,
        };
      }
      return { metric: item.metric, values: [] };
    });
  }
  if (data.resultType === "matrix") {
    return data.result.map((item) => {
      const floats = item.values ?? [];
      const counts = (item.histograms ?? []).map(
        ([at, value]): [number, string] => [at, value.count],
      );
      const values = [...floats, ...counts].sort((a, b) => a[0] - b[0]);
      return {
        metric: item.metric,
        values,
        ...(counts.length > 0 && { histogram: true as const }),
      };
    });
  }
  // A scalar and a string are one unlabelled reading, not a list of two.
  return [{ metric: {}, values: [data.result] }];
}

async function parseEnvelope(
  endpoint: MetricsEndpoint,
  res: Response,
): Promise<MetricsQueryData> {
  const body = await readJson(endpoint, res, "a query");
  const envelope = parse(QUERY_ENVELOPE, body, endpoint, res.status, "a query");
  if (envelope.status === "error") {
    throw new MetricsApiError(
      "bad_query",
      res.status,
      envelope.error ?? "query failed",
    );
  }
  if (!res.ok || envelope.data === undefined) {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} without a success envelope`,
    );
  }
  return {
    resultType: envelope.data.resultType,
    series: seriesOf(envelope.data),
    warnings: envelope.warnings ?? [],
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
  return await parseEnvelope(endpoint, res);
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
  return await parseEnvelope(endpoint, res);
}

// One currently-active instance of an alerting rule, as the source itself sees
// it. The labels identify which instance, since one rule fires per series.
interface FiringInstance {
  labels: Record<string, string>;
  state: string;
}

/* The spec types a rule as a bare object, so these field names come from the
   prose docs. A recording rule carries no state, which is why it is optional. */
const RULE = z.looseObject({
  name: z.string(),
  // Optional because only the listing reads it: a recovery check needs the
  // name and the alerts alone, and should not fail for a field it ignores.
  query: z.string().optional(),
  state: z.string().optional(),
  alerts: z
    .array(z.looseObject({ labels: LABELS.optional(), state: z.string() }))
    .optional(),
});

const RULES_ENVELOPE = z.looseObject({
  status: z.enum(["success", "error"]),
  data: z
    .looseObject({ groups: z.array(z.looseObject({ rules: z.array(RULE) })) })
    .optional(),
});

async function ruleGroups(
  endpoint: MetricsEndpoint,
  path: string,
): Promise<z.infer<typeof RULE>[] | null> {
  const res = await metricsFetch(endpoint, path);
  const body = await readJson(endpoint, res, "listing rules");
  const envelope = parse(
    RULES_ENVELOPE,
    body,
    endpoint,
    res.status,
    "listing rules",
  );
  if (!res.ok || envelope.status !== "success" || envelope.data === undefined) {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} listing rules`,
    );
  }
  return envelope.data.groups.flatMap((group) => group.rules);
}

// The same rule on the same interval that fired the alert. `null` means no
// rule by that name, which is not the same as "it is not firing".
export async function firingInstancesOf(
  endpoint: MetricsEndpoint,
  ruleName: string,
): Promise<FiringInstance[] | null> {
  const rules = await ruleGroups(
    endpoint,
    `/api/v1/rules?type=alert&rule_name[]=${encodeURIComponent(ruleName)}`,
  );
  if (rules === null) return null;
  /* The filter is a server-side hint, not a guarantee: an older Prometheus
     ignores rule_name[], and vmalert documents no support for it at all. */
  const named = rules.filter((rule) => rule.name === ruleName);
  if (named.length === 0) return null;
  return named.flatMap((rule) =>
    (rule.alerts ?? []).map((alert) => ({
      labels: alert.labels ?? {},
      state: alert.state,
    })),
  );
}

// One alerting rule as the source holds it: the expression it evaluates and
// whether it is currently firing.
export interface AlertingRule {
  name: string;
  // Absent where the source did not report one, which is a gap in the answer
  // rather than a rule that tests nothing.
  query?: string;
  state: string;
  firingCount: number;
}

export async function alertingRules(
  endpoint: MetricsEndpoint,
): Promise<AlertingRule[]> {
  const rules = await ruleGroups(endpoint, "/api/v1/rules?type=alert");
  return (rules ?? []).map((rule) => ({
    name: rule.name,
    ...(rule.query !== undefined && { query: rule.query }),
    state: rule.state ?? "unknown",
    firingCount: (rule.alerts ?? []).length,
  }));
}

const NAMES_ENVELOPE = z.looseObject({
  status: z.enum(["success", "error"]),
  data: z.array(z.string()).optional(),
});

/* The window is passed because VictoriaMetrics defaults this endpoint to the
   day so far, where Prometheus defaults to all time, and answers no differently. */
export async function metricNames(
  endpoint: MetricsEndpoint,
  contains: string | null,
  startIso: string,
  endIso: string,
): Promise<string[]> {
  const query = new URLSearchParams({ start: startIso, end: endIso });
  const res = await metricsFetch(
    endpoint,
    `/api/v1/label/__name__/values?${query.toString()}`,
  );
  const body = await readJson(endpoint, res, "listing metric names");
  const envelope = parse(
    NAMES_ENVELOPE,
    body,
    endpoint,
    res.status,
    "listing metric names",
  );
  if (!res.ok || envelope.status !== "success") {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} listing metric names`,
    );
  }
  const all = envelope.data ?? [];
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

const METADATA_ENVELOPE = z.looseObject({
  status: z.enum(["success", "error"]),
  data: z
    .record(
      z.string(),
      z.array(
        z.looseObject({
          type: z.string().optional(),
          unit: z.string().optional(),
          help: z.string().optional(),
        }),
      ),
    )
    .optional(),
});

export async function metricMetadata(
  endpoint: MetricsEndpoint,
  metric: string,
): Promise<MetricMetadata | null> {
  const res = await metricsFetch(
    endpoint,
    `/api/v1/metadata?metric=${encodeURIComponent(metric)}`,
  );
  const body = await readJson(endpoint, res, "reading metric metadata");
  const envelope = parse(
    METADATA_ENVELOPE,
    body,
    endpoint,
    res.status,
    "reading metric metadata",
  );
  if (!res.ok || envelope.status !== "success") {
    throw new MetricsApiError(
      "bad_response",
      res.status,
      `${endpoint.name} returned ${res.status} reading metric metadata`,
    );
  }
  const row = envelope.data?.[metric]?.[0];
  if (row === undefined) return null;
  return {
    metric,
    type: row.type ?? "unknown",
    unit: row.unit ?? "",
    help: row.help ?? "",
  };
}
