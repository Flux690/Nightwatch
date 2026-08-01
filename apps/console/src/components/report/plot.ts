import type { NormalizedAlert } from "@nightwarden/shared";
import { asRecord } from "@/lib/toolResult";

/* What a measurement result is drawn as, decided by the shape of the data and
   never by the model: points over time are a line, a reading per label is a
   comparison, one reading is a number. */

export interface Point {
  at: string;
  value: number;
}

export type Plot =
  | { kind: "line"; label: string; points: Point[] }
  | { kind: "bars"; bars: { label: string; value: number }[] }
  | { kind: "value"; label: string; value: number };

interface Series {
  metric: Record<string, string>;
  points: Point[];
}

// Labels every alert carries: they identify the rule, not the service, so
// matching on them would pick an arbitrary series rather than the one under
// investigation.
const IGNORED_MATCH_LABELS = new Set([
  "alertname",
  "severity",
  "job",
  "prometheus",
]);

// Enough to show the shape of a window without drawing a point per pixel.
const MAX_POINTS = 80;

function labelOf(metric: Record<string, string>): string {
  const name = metric["__name__"] ?? "series";
  const qualifier =
    metric["container"] ?? metric["pod"] ?? metric["job"] ?? metric["instance"];
  return qualifier ? `${name} (${qualifier})` : name;
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Prometheus and Loki both answer [unix seconds, value-as-string] pairs, so one
// reader serves both and any future source that speaks the same shape.
function pointsFrom(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) return [];
    const [at, raw] = pair;
    const parsed = Number(raw);
    return typeof at === "number" && Number.isFinite(parsed)
      ? [{ at: new Date(at * 1000).toISOString(), value: parsed }]
      : [];
  });
}

function seriesFrom(result: unknown): Series[] {
  const record = asRecord(result);
  const raw = record === null ? null : record["series"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const series = asRecord(entry);
    if (series === null) return [];
    const points = pointsFrom(series["values"]);
    return points.length === 0
      ? []
      : [{ metric: stringMap(series["metric"]), points }];
  });
}

// Prefer the series whose labels mention the alert, so a chart shows the one
// under investigation. Matched on the alert's own label values, which came from
// the metrics source and so are the vocabulary the series already carry.
function pickSeries(series: Series[], alert: NormalizedAlert | null): Series {
  const first = series[0]!;
  if (alert === null) return first;
  const tokens = Object.entries(alert.labels)
    .filter(([key]) => !IGNORED_MATCH_LABELS.has(key))
    .map(([, value]) => value)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return first;
  return (
    series.find((s) => {
      const labels = JSON.stringify(s.metric);
      return tokens.some((t) => labels.includes(t));
    }) ?? first
  );
}

function downsample(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const stride = (points.length - 1) / (MAX_POINTS - 1);
  return Array.from(
    { length: MAX_POINTS },
    (_, i) => points[Math.round(i * stride)]!,
  );
}

// Null when the result holds no measurement at all, which is the caller's cue
// to fall back to quoting it. Nothing here summarises: every number drawn came
// from the recorded result.
export function plotFrom(
  result: unknown,
  alert: NormalizedAlert | null,
): Plot | null {
  const series = seriesFrom(result);
  if (series.length === 0) return null;

  const overTime = series.filter((s) => s.points.length > 1);
  if (overTime.length > 0) {
    const chosen = pickSeries(overTime, alert);
    return {
      kind: "line",
      label: labelOf(chosen.metric),
      points: downsample(chosen.points),
    };
  }

  // One reading each: there is no time axis to draw, so the comparison across
  // labels is the measurement, and a lone reading is just its number.
  if (series.length > 1) {
    return {
      kind: "bars",
      bars: series.map((s) => ({
        label: labelOf(s.metric),
        value: s.points[0]!.value,
      })),
    };
  }
  return {
    kind: "value",
    label: labelOf(series[0]!.metric),
    value: series[0]!.points[0]!.value,
  };
}
