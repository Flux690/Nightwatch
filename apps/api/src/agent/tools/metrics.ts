import {
  MetricsApiError,
  alertingRules,
  instantQuery,
  metricMetadata,
  metricNames,
  rangeQuery,
  type AlertingRule,
  type MetricsQueryData,
  type MetricsSeries,
} from "../../integrations/metrics/client.js";
import {
  listMetricsBackends,
  soleMetricsBackend,
  type MetricsBackend,
} from "../../integrations/metrics/backends.js";
import { alertAnchorFor } from "./alert-anchor.js";
import { fitWithinBudget } from "./result-budget.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire.
interface MetricsQueryResult {
  resultType: string;
  series: MetricsSeries[];
  seriesOmitted?: number;
}

export interface MetricsRangeResult extends MetricsQueryResult {
  windowStart: string;
  windowEnd: string;
  stepSeconds: number;
}

interface MetricNamesResult {
  names: string[];
  namesOmitted?: number;
}

interface AlertRulesResult {
  rules: AlertingRule[];
  rulesOmitted?: number;
}

const DEFAULT_LOOKBACK_MINUTES = 180;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LOOKFORWARD_MINUTES = 30;
// 20 labelsets is plenty to see a pattern; an unaggregated query over a busy
// fleet returns hundreds, which would drown the transcript.
const MAX_SERIES = 20;
const TARGET_POINTS_PER_SERIES = 200;
// Enough to recognise a naming scheme and pick the right metric; a fleet's full
// name list runs to thousands and would drown the turn that asked for it.
const MAX_METRIC_NAMES = 100;
const MAX_ALERT_RULES = 50;

/* Consulted only when more than one backend is connected, exactly as `runner`
   is consulted only for a shared target key. Named after the context block that
   lists them, so the model copies a name rather than inventing one. */
const BACKEND_PROPERTY = {
  type: "string",
  description:
    "The name of one metrics backend, written exactly as the METRICS BACKENDS list gives it. Supply this only when that list shows more than one; with a single backend connected it is the only one there is, and naming it changes nothing.",
} as const;

function clampedNumber(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = input[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(raw, max);
}

// Capped by count, then by size: a range query returns twenty series of two
// hundred points each, which is several times what one result may occupy.
function capSeries(data: MetricsQueryData): MetricsQueryResult {
  const { kept, dropped } = fitWithinBudget(data.series.slice(0, MAX_SERIES));
  const omitted = data.series.length - MAX_SERIES + dropped;
  return {
    resultType: data.resultType,
    series: kept,
    ...(omitted > 0 && { seriesOmitted: omitted }),
  };
}

/* Which backend this call means. One connected needs no argument; several make
   the argument required, because guessing which of two Prometheus clusters was
   meant would answer a question nobody asked. */
function resolveBackend(
  input: Record<string, unknown>,
): MetricsBackend | ToolExecuteResult {
  const all = listMetricsBackends();
  if (all.length === 0) {
    return {
      content:
        "No metrics backend is connected. The user can connect one from the Integrations page. Continue without metric evidence.",
      outcome: "permission",
    };
  }
  const named = input["backend"];
  if (typeof named !== "string" || named.trim() === "") {
    const sole = soleMetricsBackend();
    if (sole !== null) return sole;
    return {
      content: `More than one metrics backend is connected, so name the one you mean in "backend": ${all
        .map((b) => b.label)
        .join(", ")}.`,
      outcome: "system",
    };
  }
  const wanted = named.trim().toLowerCase();
  const match = all.find((b) => b.label.toLowerCase() === wanted);
  if (match !== undefined) return match;
  return {
    content: `No metrics backend is named "${named.trim()}". The connected ones are: ${all
      .map((b) => b.label)
      .join(", ")}.`,
    outcome: "system",
  };
}

function isBackend(
  resolved: MetricsBackend | ToolExecuteResult,
): resolved is MetricsBackend {
  return "capabilities" in resolved;
}

function corrective(err: unknown): ToolExecuteResult {
  if (err instanceof MetricsApiError) {
    if (err.code === "bad_query") {
      return {
        content: `The backend rejected the query: ${err.message}. Fix the PromQL and retry.`,
        outcome: "system",
      };
    }
    return {
      content: `Metrics request failed: ${err.message}. If this persists the user must fix the connection on the Integrations page.`,
      outcome: err.code === "unauthorized" ? "permission" : "retryable",
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    outcome: "system",
  };
}

export const METRICS_TOOLS: Tool[] = [
  {
    schema: {
      name: "QueryMetrics",
      description:
        "Evaluate a PromQL expression against the connected metrics backend at a single moment in time, which gives you one number rather than a series. Use it to read a value as it was when the alert fired, or as it is now. When you need to know how a value behaved over time, such as whether it climbed steadily or spiked, use QueryMetricsRange instead.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The PromQL expression to evaluate.",
          },
          at: {
            type: "string",
            enum: ["now", "alert"],
            description:
              "Which moment to evaluate at. 'now', the default, reads the current value. 'alert' reads the value as of the instant the alert that opened this investigation fired; on a session no alert opened, it means the same as 'now'.",
          },
          backend: BACKEND_PROPERTY,
        },
        required: ["query"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const backend = resolveBackend(input);
      if (!isBackend(backend)) return backend;
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a PromQL string", outcome: "system" };
      }
      try {
        const data = await instantQuery(
          backend.query,
          query,
          input["at"] === "alert"
            ? alertAnchorFor(ctx.sessionId).toISOString()
            : undefined,
        );
        const result: MetricsQueryResult = capSeries(data);
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },
  {
    schema: {
      name: "QueryMetricsRange",
      description:
        "Evaluate a PromQL expression against the connected metrics backend across a window of time around the alert, or around now if no alert started this session. This is how you see the shape of a problem: whether a value rose gradually or jumped, and whether it recovered afterwards. Use rate() and aggregations to keep the number of returned series small, because only the first twenty are returned.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The PromQL expression to evaluate.",
          },
          lookbackMinutes: {
            type: "number",
            description:
              "How many minutes before the alert to include. Defaults to 180, and the maximum is 10080, which is one week.",
          },
          lookforwardMinutes: {
            type: "number",
            description:
              "How many minutes after the alert to include, which is how you tell whether it recovered. Defaults to 30, and never extends past now.",
          },
          stepSeconds: {
            type: "number",
            description:
              "How far apart the sampled points are. Omit this and a step is chosen that fits roughly 200 points across the window.",
          },
          backend: BACKEND_PROPERTY,
        },
        required: ["query"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "metric",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const backend = resolveBackend(input);
      if (!isBackend(backend)) return backend;
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a PromQL string", outcome: "system" };
      }

      const anchor = alertAnchorFor(ctx.sessionId);
      const lookbackMs =
        clampedNumber(
          input,
          "lookbackMinutes",
          DEFAULT_LOOKBACK_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ) * 60_000;
      const lookforwardMs =
        clampedNumber(
          input,
          "lookforwardMinutes",
          DEFAULT_LOOKFORWARD_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ) * 60_000;
      // Metrics after the alert are evidence too (did it recover?), but the
      // window never extends into the future.
      const end = new Date(
        Math.min(anchor.getTime() + lookforwardMs, Date.now()),
      );
      const start = new Date(anchor.getTime() - lookbackMs);
      const windowSeconds = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 1000),
      );
      const step = Math.round(
        clampedNumber(
          input,
          "stepSeconds",
          Math.max(15, Math.ceil(windowSeconds / TARGET_POINTS_PER_SERIES)),
          windowSeconds,
        ),
      );

      try {
        const data = await rangeQuery(
          backend.query,
          query,
          start.toISOString(),
          end.toISOString(),
          step,
        );
        const result: MetricsRangeResult = {
          ...capSeries(data),
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          stepSeconds: step,
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },

  {
    schema: {
      name: "ListMetricNames",
      description:
        "List the metric names this backend is currently storing, narrowed by a substring. Call it before querying a metric you have not already seen in an alert label or an earlier result: a PromQL expression naming a metric that does not exist returns no series, which reads as 'the value is fine' rather than as a mistake. Returns names only, not values or labels.",
      input_schema: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description:
              "Case-insensitive substring the name must contain, such as 'memory' or 'http_request'. Omit to list everything, which on a busy fleet is thousands of names.",
          },
          backend: BACKEND_PROPERTY,
        },
        required: [],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input): Promise<ToolExecuteResult> => {
      const backend = resolveBackend(input);
      if (!isBackend(backend)) return backend;
      const contains = input["contains"];
      try {
        const names = await metricNames(
          backend.query,
          typeof contains === "string" && contains.trim() !== ""
            ? contains.trim()
            : null,
        );
        if (names.length === 0) {
          return {
            content:
              "No metric names matched. Widen the substring, or drop it to see what this backend stores at all.",
            outcome: "expected_miss",
          };
        }
        const result: MetricNamesResult = {
          names: names.slice(0, MAX_METRIC_NAMES),
          ...(names.length > MAX_METRIC_NAMES && {
            namesOmitted: names.length - MAX_METRIC_NAMES,
          }),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },

  {
    schema: {
      name: "GetMetricMetadata",
      description:
        "Read what a metric measures and how: its type (counter, gauge, histogram, summary), its unit where the exporter declared one, and its help text. A counter only means something through rate() and a raw read of one is meaningless, so check the type before writing an expression against an unfamiliar metric. Not every backend stores this, and the result says so when it does not.",
      input_schema: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            description:
              "The exact metric name, as it appears in ListMetricNames or in a series you have already queried.",
          },
          backend: BACKEND_PROPERTY,
        },
        required: ["metric"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input): Promise<ToolExecuteResult> => {
      const backend = resolveBackend(input);
      if (!isBackend(backend)) return backend;
      const metric = input["metric"];
      if (typeof metric !== "string" || metric.trim() === "") {
        return { content: "metric must be a name", outcome: "system" };
      }
      /* Stated, not discovered: VictoriaMetrics answers this endpoint with an empty
         object for every metric, so reporting the emptiness would be a fact about
         VictoriaMetrics dressed as a fact about the metric. */
      if (!backend.capabilities.metricMetadata) {
        return {
          content: `${backend.label} does not implement the metric metadata API - it answers with an empty result for every metric, so nothing here can tell you the type or unit of "${metric.trim()}". This says nothing about whether the metric exists. Read its type from the exporter, or infer it from how the values behave over a range.`,
          outcome: "expected_miss",
        };
      }
      try {
        const meta = await metricMetadata(backend.query, metric.trim());
        if (meta === null) {
          return {
            content: `No exporter declared metadata for "${metric.trim()}" on ${backend.label}. The metric may still exist and be queryable.`,
            outcome: "expected_miss",
          };
        }
        return { content: meta };
      } catch (err) {
        return corrective(err);
      }
    },
  },

  {
    schema: {
      name: "ListAlertRules",
      description:
        "List the alerting rules this backend evaluates, each with the PromQL expression it tests and whether it is firing now. This is how you read the condition behind an alert rather than inferring it from the alert's labels: the expression names the metric, the threshold and the window that fired. Returns rule definitions and current state, not the history of when a rule fired.",
      input_schema: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description:
              "Case-insensitive substring the rule name must contain. Omit to list every rule.",
          },
          backend: BACKEND_PROPERTY,
        },
        required: [],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input): Promise<ToolExecuteResult> => {
      const backend = resolveBackend(input);
      if (!isBackend(backend)) return backend;
      /* A backend with no rules endpoint has not told us it evaluates no rules;
         it has told us nothing. VictoriaMetrics serves them from vmalert alone,
         and Grafana Cloud from the Grafana stack behind another credential. */
      if (backend.rules === null) {
        return {
          content: `No rules endpoint is configured for ${backend.label}, so nothing here can say which alerting rules it evaluates or whether any is firing. This is a gap in the connection, not an absence of rules. The user can add the rules URL on the Integrations page - on VictoriaMetrics it is vmalert's address, and on Grafana Cloud the Grafana stack's.`,
          outcome: "permission",
        };
      }
      const contains = input["contains"];
      const needle =
        typeof contains === "string" && contains.trim() !== ""
          ? contains.trim().toLowerCase()
          : null;
      try {
        const rules = await alertingRules(backend.rules);
        const matched =
          needle === null
            ? rules
            : rules.filter((r) => r.name.toLowerCase().includes(needle));
        if (matched.length === 0) {
          return {
            content:
              needle === null
                ? `${backend.label} returned no alerting rules. That is not proof it evaluates none: a VictoriaMetrics query endpoint answers this the same way, with an empty list, when the rules actually live in vmalert.`
                : `No alerting rule name contains "${contains as string}".`,
            outcome: "expected_miss",
          };
        }
        const { kept } = fitWithinBudget(matched.slice(0, MAX_ALERT_RULES));
        const rulesOmitted = matched.length - kept.length;
        const result: AlertRulesResult = {
          rules: kept,
          ...(rulesOmitted > 0 && { rulesOmitted }),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },
];
