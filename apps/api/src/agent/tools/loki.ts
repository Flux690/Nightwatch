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
import { ITEM_BUDGET_CHARS, fitWithinBudget } from "./result-budget.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire.
interface LokiLogLine {
  ts: string;
  line: string;
}

interface LokiLogStream {
  labels: Record<string, string>;
  lines: LokiLogLine[];
}

export interface LokiLogsResult {
  streams: LokiLogStream[];
  returnedLines: number;
  limit: number;
  hitLimit: boolean;
  linesTruncated: number;
  // Matched the query but did not fit the budget, so this result is partial.
  linesDropped: number;
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

// The window ends where the caller aims it rather than at the alert, which is
// what lets a second call reach past the first one's budget.
function aimedWindow(
  until: Date,
  lookbackMinutes: number,
): { start: Date; end: Date } {
  const end = new Date(Math.min(until.getTime(), Date.now()));
  return {
    start: new Date(end.getTime() - lookbackMinutes * 60_000),
    end,
  };
}

// Absent is the alert; unparseable is the model's mistake and is corrected
// rather than silently read as absent.
function parseUntil(raw: unknown): Date | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? "invalid" : at;
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
      "Loki integration is not configured. The user can connect it from the Integrations page. Continue without log evidence.",
    outcome: "permission",
  };
}

function corrective(err: unknown): ToolExecuteResult {
  if (err instanceof LokiApiError) {
    if (err.code === "bad_query") {
      return {
        content: `Loki rejected the query: ${err.message}. Fix the LogQL and retry.`,
        outcome: "system",
      };
    }
    return {
      content: `Loki request failed: ${err.message}. If this persists the user must fix the connection on the Integrations page.`,
      outcome: err.code === "unauthorized" ? "permission" : "retryable",
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    outcome: "system",
  };
}

// Capped by count, then by size: twenty series of two hundred points each is
// well past what one result may occupy.
function capMetricSeries(data: LokiMetricData): {
  series: LokiMetricSeries[];
  seriesOmitted?: number;
} {
  const { kept, dropped } = fitWithinBudget(data.series.slice(0, MAX_SERIES));
  const omitted = data.series.length - MAX_SERIES + dropped;
  return {
    series: kept,
    ...(omitted > 0 && { seriesOmitted: omitted }),
  };
}

export const LOKI_TOOLS: Tool[] = [
  {
    schema: {
      name: "QueryLogs",
      description:
        'Read individual log lines from the connected Loki, selected with a LogQL query such as {app="api"} |= "error". Lines come back newest first, from a window around the alert or around now if no alert started this session. Every LogQL query has to begin with a label selector in braces, so if you do not already know which labels select this service, call DiscoverLogLabels first. Narrow the query itself with filters such as |= and |~ rather than fetching everything and reading through it.',
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'The LogQL query, which must begin with a stream selector in braces, for example {namespace="shop", app="api"} |= "error".',
          },
          limit: {
            type: "number",
            description:
              "How many lines to return at most, newest first. Defaults to 100, and the maximum is 1000.",
          },
          lookbackMinutes: {
            type: "number",
            description:
              "How many minutes before the alert to search. Defaults to 60, and the maximum is 10080, which is one week.",
          },
          lookforwardMinutes: {
            type: "number",
            description:
              "How many minutes after the alert to search. Defaults to 5, and never extends past now. Ignored when until is given.",
          },
          until: {
            type: "string",
            description:
              "Where the window ends, as an ISO 8601 timestamp, so you can read a moment other than the alert. The window becomes the lookbackMinutes ending here. Use it to look at when something started, taking the time from a QueryLogMetrics series, or to continue past a result that hit its budget by passing the ts of the oldest line you received. Defaults to the alert.",
          },
        },
        required: ["query"],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "logs",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getLokiIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a LogQL string", outcome: "system" };
      }

      const until = parseUntil(input["until"]);
      if (until === "invalid") {
        return {
          content:
            "until must be an ISO 8601 timestamp, for example 2026-08-10T11:23:00Z. Copy it from a tool result rather than composing one.",
          outcome: "system",
        };
      }

      const limit = Math.round(
        clampedNumber(input, "limit", DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT),
      );
      const lookbackMinutes = clampedNumber(
        input,
        "lookbackMinutes",
        DEFAULT_LOG_LOOKBACK_MINUTES,
        MAX_LOOKBACK_MINUTES,
      );
      const { start, end } =
        until === null
          ? anchoredWindow(
              ctx.sessionId,
              lookbackMinutes,
              clampedNumber(
                input,
                "lookforwardMinutes",
                DEFAULT_LOG_LOOKFORWARD_MINUTES,
                MAX_LOOKBACK_MINUTES,
              ),
            )
          : aimedWindow(until, lookbackMinutes);

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
        let linesDropped = 0;
        let spent = 0;
        // Whole lines are dropped rather than the text cut mid-result, so what
        // does arrive is every character of the lines it claims to carry.
        const streams: LokiLogStream[] = [];
        for (const s of data.streams) {
          const lines: LokiLogLine[] = [];
          for (const [ns, raw] of s.values) {
            const truncated = raw.length > MAX_LINE_CHARS;
            const line = truncated
              ? raw.slice(0, MAX_LINE_CHARS) + " …[truncated]"
              : raw;
            if (spent + line.length > ITEM_BUDGET_CHARS) {
              linesDropped++;
              continue;
            }
            spent += line.length;
            returnedLines++;
            if (truncated) linesTruncated++;
            lines.push({ ts: nsToIso(ns), line });
          }
          if (lines.length > 0) streams.push({ labels: s.labels, lines });
        }

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
        if (linesDropped > 0) {
          const oldest = streams.at(-1)?.lines.at(-1)?.ts;
          notes.push(
            `${linesDropped} matching line(s) are NOT in this result: it reached its ${ITEM_BUDGET_CHARS}-character budget. Lines come back newest first, so the ones missing are older than what you see. Prefer narrowing the selector, or counting them with QueryLogMetrics, over reading them all${oldest === undefined ? "" : `; to read the next ones, call again with until="${oldest}"`}. Do not read the absence of a line as evidence it did not occur.`,
          );
        }

        const result: LokiLogsResult = {
          streams,
          returnedLines,
          limit,
          hitLimit,
          linesTruncated,
          linesDropped,
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
        'Count or rate log lines in the connected Loki using a metric-style LogQL expression, for example sum(rate({app="api"} |= "error" [5m])), across a window around the alert. Use this when you want a number derived from logs that Prometheus does not record, such as how often a particular message appears. When you want to read the lines themselves, use QueryLogs. Keep the number of returned series small with aggregations, because only the first twenty are returned.',
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The metric-style LogQL expression. It has to produce a range vector, which means using a function such as rate() or count_over_time() with a range in square brackets.",
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
      const integration = getLokiIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a LogQL string", outcome: "system" };
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
        "Find out which labels select a particular service's logs in Loki. There is no fixed convention for these, so you cannot guess them reliably; call this before QueryLogs whenever you do not already know the selector. Called with no arguments it lists the label names present around the alert. Given a label name it lists that label's values. Given a partial selector it lists the label sets of the streams that match, so you can narrow down from there.",
      input_schema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "A label name whose values you want listed, for example 'app'. Omit it to list the label names instead.",
          },
          selector: {
            type: "string",
            description:
              'A partial LogQL selector, for example {namespace="shop"}, whose matching streams you want the full label sets of.',
          },
        },
        required: [],
      },
    },
    effect: "read",
    policy: "auto",
    evidenceKind: "text",
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
