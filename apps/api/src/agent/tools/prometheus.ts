import { decrypt } from "../../config/crypto.js";
import { getPrometheusIntegration } from "../../db/prometheus-integration.js";
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
    is_error: true,
  };
}

function corrective(err: unknown): ToolExecuteResult {
  const detail =
    err instanceof PrometheusApiError
      ? err.code === "bad_query"
        ? `Prometheus rejected the query: ${err.message}. Fix the PromQL and retry.`
        : `Prometheus request failed: ${err.message}. If this persists the operator must fix the connection on the Integrations page.`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: detail, is_error: true };
}

export const PROMETHEUS_TOOLS: Tool[] = [
  {
    schema: {
      name: "QueryMetrics",
      description:
        "Evaluate a PromQL expression at a single instant against the connected Prometheus. Use at='alert' to read the value as of the moment the alert fired, or the default 'now' for current state. For the shape over time (climbing vs spiking), use QueryMetricsRange instead.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "PromQL expression to evaluate.",
          },
          at: {
            type: "string",
            enum: ["now", "alert"],
            description:
              "Evaluation instant: 'now' (default) or 'alert' (the alert's firedAt).",
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
        return { content: "query must be a PromQL string", is_error: true };
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
        "Evaluate a PromQL expression over a time window around the alert (or now, for chat sessions) against the connected Prometheus. This draws the timeline: whether a metric climbed slowly or spiked, and whether it recovered after the alert. Prefer rate()/aggregations that keep the series count small.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "PromQL expression to evaluate.",
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
      const integration = getPrometheusIntegration();
      if (integration === null) return notConfigured();
      const query = input["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "query must be a PromQL string", is_error: true };
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
