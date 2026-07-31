import { decrypt } from "../../secrets.js";
import { getPrometheusIntegration } from "../../db/integrations.js";
import {
  PrometheusApiError,
  instantQuery,
  rangeQuery,
  type PrometheusQueryData,
  type PrometheusSeries,
} from "../../integrations/prometheus.js";
import { alertAnchorFor } from "./alert-anchor.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire.
export interface MetricsQueryResult {
  resultType: string;
  series: PrometheusSeries[];
  seriesOmitted?: number;
}

export interface MetricsRangeResult extends MetricsQueryResult {
  windowStart: string;
  windowEnd: string;
  stepSeconds: number;
}

const DEFAULT_LOOKBACK_MINUTES = 180;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_LOOKFORWARD_MINUTES = 30;
// 20 labelsets is plenty to see a pattern; an unaggregated query over a busy
// fleet returns hundreds, which would drown the transcript.
const MAX_SERIES = 20;
const TARGET_POINTS_PER_SERIES = 200;

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

function capSeries(data: PrometheusQueryData): MetricsQueryResult {
  const omitted = data.series.length - MAX_SERIES;
  return {
    resultType: data.resultType,
    series: data.series.slice(0, MAX_SERIES),
    ...(omitted > 0 && { seriesOmitted: omitted }),
  };
}

function notConfigured(): ToolExecuteResult {
  return {
    content:
      "Prometheus integration is not configured. The operator can connect it from the Integrations page. Continue without metric evidence.",
    outcome: "permission",
  };
}

function corrective(err: unknown): ToolExecuteResult {
  if (err instanceof PrometheusApiError) {
    if (err.code === "bad_query") {
      return {
        content: `Prometheus rejected the query: ${err.message}. Fix the PromQL and retry.`,
        outcome: "system",
      };
    }
    return {
      content: `Prometheus request failed: ${err.message}. If this persists the operator must fix the connection on the Integrations page.`,
      outcome: err.code === "unauthorized" ? "permission" : "retryable",
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    outcome: "system",
  };
}

export const PROMETHEUS_TOOLS: Tool[] = [
  {
    schema: {
      name: "QueryMetrics",
      description:
        "Evaluate a PromQL expression against the connected Prometheus at a single moment in time, which gives you one number rather than a series. Use it to read a value as it was when the alert fired, or as it is now. When you need to know how a value behaved over time, such as whether it climbed steadily or spiked, use QueryMetricsRange instead.",
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
              "Which moment to evaluate at. 'now' is the default and reads the current value; 'alert' reads the value as of the instant the alert fired.",
          },
        },
        required: ["query"],
      },
    },
    access: "read",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getPrometheusIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a PromQL string", outcome: "system" };
      }
      try {
        const data = await instantQuery(
          integration.baseUrl,
          integration.authHeaderEncrypted
            ? decrypt(integration.authHeaderEncrypted)
            : null,
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
        "Evaluate a PromQL expression against the connected Prometheus across a window of time around the alert, or around now if no alert started this session. This is how you see the shape of a problem: whether a value rose gradually or jumped, and whether it recovered afterwards. Use rate() and aggregations to keep the number of returned series small, because only the first twenty are returned.",
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
        },
        required: ["query"],
      },
    },
    access: "read",
    timeoutMs: 30_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getPrometheusIntegration();
      if (integration === null) return notConfigured();
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
          integration.baseUrl,
          integration.authHeaderEncrypted
            ? decrypt(integration.authHeaderEncrypted)
            : null,
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
];
