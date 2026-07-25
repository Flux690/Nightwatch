import { decrypt } from "../../secrets.js";
import { getLokiIntegration } from "../../db/integrations.js";
import {
  LokiApiError,
  labelNames,
  labelValues,
  queryLogRange,
  queryMetricRange,
  series,
  type LokiMetricData,
  type LokiMetricSeries,
} from "../../integrations/loki.js";
import { alertAnchorFor } from "./alert-anchor.js";
import type { Tool, ToolExecuteContext, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire.
export interface LokiLogLine {
  ts: string;
  line: string;
}

export interface LokiLogStream {
  labels: Record<string, string>;
  lines: LokiLogLine[];
}

export interface LokiLogsResult {
  streams: LokiLogStream[];
  returnedLines: number;
  limit: number;
  hitLimit: boolean;
  linesTruncated: number;
  windowStart: string;
  windowEnd: string;
  note: string;
}

export interface LokiMetricsResult {
  resultType: string;
  series: LokiMetricSeries[];
  seriesOmitted?: number;
  windowStart: string;
  windowEnd: string;
  stepSeconds: number;
}

export interface LogLabelsResult {
  mode: "labels" | "values" | "series";
  windowStart: string;
  windowEnd: string;
  labels?: string[];
  label?: string;
  values?: string[];
  selector?: string;
  matches?: Array<Record<string, string>>;
  omitted?: number;
  note: string;
}

const DEFAULT_LOG_LOOKBACK_MINUTES = 60;
const DEFAULT_LOG_LOOKFORWARD_MINUTES = 5;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 1_000;
// A single JSON-blob line can dwarf the rest of the transcript; cap each line so
// one verbose log cannot blow the context budget.
const MAX_LINE_CHARS = 2_000;

const DEFAULT_METRIC_LOOKBACK_MINUTES = 180;
const DEFAULT_METRIC_LOOKFORWARD_MINUTES = 30;
const MAX_SERIES = 20;
const TARGET_POINTS_PER_SERIES = 200;

// Discovery looks at a tight window around the alert so it lists only labels
// present near the incident, not every stream Loki has ever seen.
const DISCOVERY_LOOKBACK_MINUTES = 60;
const DISCOVERY_LOOKFORWARD_MINUTES = 5;
const MAX_LABELS = 200;
const MAX_SERIES_MATCHES = 50;

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

// Evidence windows never extend into the future; metrics/logs after the alert
// are still evidence (did it recover?) up to now.
function anchoredWindow(
  sessionId: string,
  lookbackMinutes: number,
  lookforwardMinutes: number,
): { start: Date; end: Date } {
  const anchor = alertAnchorFor(sessionId);
  const start = new Date(anchor.getTime() - lookbackMinutes * 60_000);
  const end = new Date(
    Math.min(anchor.getTime() + lookforwardMinutes * 60_000, Date.now()),
  );
  return { start, end };
}

function nsToIso(ns: string): string {
  try {
    const d = new Date(Number(BigInt(ns) / 1_000_000n));
    return Number.isNaN(d.getTime()) ? ns : d.toISOString();
  } catch {
    return ns;
  }
}

function decryptedAuth(authHeaderEncrypted: string | null): string | null {
  return authHeaderEncrypted ? decrypt(authHeaderEncrypted) : null;
}

function notConfigured(): ToolExecuteResult {
  return {
    content:
      "Loki integration is not configured. The operator can connect it from the Integrations page. Continue without log evidence.",
    is_error: true,
  };
}

function corrective(err: unknown): ToolExecuteResult {
  const detail =
    err instanceof LokiApiError
      ? err.code === "bad_query"
        ? `Loki rejected the query: ${err.message}. Fix the LogQL and retry.`
        : `Loki request failed: ${err.message}. If this persists the operator must fix the connection on the Integrations page.`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: detail, is_error: true };
}

function capMetricSeries(data: LokiMetricData): {
  series: LokiMetricSeries[];
  seriesOmitted?: number;
} {
  const omitted = data.series.length - MAX_SERIES;
  return {
    series: data.series.slice(0, MAX_SERIES),
    ...(omitted > 0 && { seriesOmitted: omitted }),
  };
}

export const LOKI_TOOLS: Tool[] = [
  {
    schema: {
      name: "QueryLogs",
      description:
        'Fetch log LINES from the connected Loki with a LogQL stream selector (e.g. {app="api"} |= "error"). Returns the newest lines first within a window around the alert (or now, for chat sessions). Every LogQL query must start with a label selector - if you do not know the labels, call DiscoverLogLabels first. Filter server-side in the query (|=, |~, json ...) rather than pulling everything.',
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'LogQL log query, starting with a stream selector, e.g. {namespace="shop", app="api"} |= "error".',
          },
          limit: {
            type: "number",
            description:
              "Max lines to return, newest first (default 100, max 1000).",
          },
          lookbackMinutes: {
            type: "number",
            description:
              "Minutes before the alert to search (default 60, max 10080).",
          },
          lookforwardMinutes: {
            type: "number",
            description:
              "Minutes after the alert to search, capped at now (default 5).",
          },
        },
        required: ["query"],
      },
    },
    access: "read",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getLokiIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a LogQL string", is_error: true };
      }

      const limit = Math.round(
        clampedNumber(input, "limit", DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
      );
      const { start, end } = anchoredWindow(
        ctx.sessionId,
        clampedNumber(
          input,
          "lookbackMinutes",
          DEFAULT_LOG_LOOKBACK_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ),
        clampedNumber(
          input,
          "lookforwardMinutes",
          DEFAULT_LOG_LOOKFORWARD_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ),
      );

      try {
        const data = await queryLogRange(
          integration.baseUrl,
          decryptedAuth(integration.authHeaderEncrypted),
          integration.orgId,
          query,
          start,
          end,
          limit,
        );

        let returnedLines = 0;
        let linesTruncated = 0;
        const streams: LokiLogStream[] = data.streams.map((s) => ({
          labels: s.labels,
          lines: s.values.map(([ns, raw]) => {
            returnedLines++;
            const truncated = raw.length > MAX_LINE_CHARS;
            if (truncated) linesTruncated++;
            return {
              ts: nsToIso(ns),
              line: truncated
                ? raw.slice(0, MAX_LINE_CHARS) + " …[truncated]"
                : raw,
            };
          }),
        }));

        const hitLimit = returnedLines >= limit;
        const notes: string[] = [];
        if (returnedLines === 0) {
          notes.push(
            "No log lines matched in the window. Check the selector with DiscoverLogLabels, or widen lookbackMinutes.",
          );
        }
        if (hitLimit) {
          notes.push(
            `Hit the ${limit}-line limit (newest first); older matching lines may exist - narrow the query or raise limit.`,
          );
        }
        if (linesTruncated > 0) {
          notes.push(
            `${linesTruncated} line(s) truncated to ${MAX_LINE_CHARS} chars.`,
          );
        }

        const result: LokiLogsResult = {
          streams,
          returnedLines,
          limit,
          hitLimit,
          linesTruncated,
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },
  {
    schema: {
      name: "QueryLogMetrics",
      description:
        'Evaluate a metric-style LogQL expression (rate/count over logs, e.g. sum(rate({app="api"} |= "error" [5m]))) over a window around the alert against the connected Loki. Use this for log-derived numbers Prometheus does not have - the count or rate of a specific log pattern. For the raw lines, use QueryLogs. Prefer aggregations that keep the series count small.',
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Metric-style LogQL expression (must produce a range vector, i.e. use rate()/count_over_time() with a [range]).",
          },
          lookbackMinutes: {
            type: "number",
            description:
              "Minutes before the alert to include (default 180, max 10080).",
          },
          lookforwardMinutes: {
            type: "number",
            description:
              "Minutes after the alert to include, capped at now (default 30).",
          },
          stepSeconds: {
            type: "number",
            description:
              "Resolution step; omit to auto-fit ~200 points across the window.",
          },
        },
        required: ["query"],
      },
    },
    access: "read",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getLokiIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a LogQL string", is_error: true };
      }

      const { start, end } = anchoredWindow(
        ctx.sessionId,
        clampedNumber(
          input,
          "lookbackMinutes",
          DEFAULT_METRIC_LOOKBACK_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ),
        clampedNumber(
          input,
          "lookforwardMinutes",
          DEFAULT_METRIC_LOOKFORWARD_MINUTES,
          MAX_LOOKBACK_MINUTES,
        ),
      );
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
        const data = await queryMetricRange(
          integration.baseUrl,
          decryptedAuth(integration.authHeaderEncrypted),
          integration.orgId,
          query,
          start,
          end,
          step,
        );
        const result: LokiMetricsResult = {
          resultType: data.resultType,
          ...capMetricSeries(data),
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
      name: "DiscoverLogLabels",
      description:
        "Discover which labels select a service's logs in Loki, since log labels are not a fixed convention. With no arguments, lists label NAMES present around the alert. With 'label', lists that label's VALUES. With 'selector' (e.g. {namespace=\"shop\"}), lists the label sets of matching streams so you can narrow further. Use this before QueryLogs when you do not already know the selector.",
      input_schema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "A label name to list values for (e.g. 'app'). Omit to list label names.",
          },
          selector: {
            type: "string",
            description:
              'A partial LogQL selector (e.g. {namespace="shop"}) to list matching streams\' label sets.',
          },
        },
        required: [],
      },
    },
    access: "read",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getLokiIntegration();
      if (integration === null) return notConfigured();
      const { baseUrl, orgId } = integration;
      const auth = decryptedAuth(integration.authHeaderEncrypted);
      const { start, end } = anchoredWindow(
        ctx.sessionId,
        DISCOVERY_LOOKBACK_MINUTES,
        DISCOVERY_LOOKFORWARD_MINUTES,
      );
      const windowStart = start.toISOString();
      const windowEnd = end.toISOString();

      try {
        const selector = input["selector"];
        if (typeof selector === "string" && selector.trim() !== "") {
          const all = await series(baseUrl, auth, orgId, selector, start, end);
          const matches = all.slice(0, MAX_SERIES_MATCHES);
          const omitted = all.length - matches.length;
          const result: LogLabelsResult = {
            mode: "series",
            windowStart,
            windowEnd,
            selector,
            matches,
            ...(omitted > 0 && { omitted }),
            note:
              all.length === 0
                ? "No streams matched that selector in the window."
                : `${all.length} stream(s) matched; pick labels from these to build a QueryLogs selector.`,
          };
          return { content: result };
        }

        const label = input["label"];
        if (typeof label === "string" && label.trim() !== "") {
          const all = await labelValues(
            baseUrl,
            auth,
            orgId,
            label,
            start,
            end,
          );
          const values = all.slice(0, MAX_LABELS);
          const omitted = all.length - values.length;
          const result: LogLabelsResult = {
            mode: "values",
            windowStart,
            windowEnd,
            label,
            values,
            ...(omitted > 0 && { omitted }),
            note:
              all.length === 0
                ? `No values for label '${label}' in the window.`
                : `Values for '${label}'. Use one in a QueryLogs selector, e.g. {${label}="..."}.`,
          };
          return { content: result };
        }

        const all = await labelNames(baseUrl, auth, orgId, start, end);
        const labels = all.slice(0, MAX_LABELS);
        const omitted = all.length - labels.length;
        const result: LogLabelsResult = {
          mode: "labels",
          windowStart,
          windowEnd,
          labels,
          ...(omitted > 0 && { omitted }),
          note:
            all.length === 0
              ? "No labels present in the window - is the Loki URL correct and are logs flowing?"
              : "Label names present around the alert. Call again with 'label' to see a label's values.",
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  },
];
