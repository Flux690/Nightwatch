import type { NormalizedAlert } from "@nightwarden/shared";
import { asRecord } from "@/lib/toolResult";

/* What a measurement result is drawn as, decided by the shape of the data and
   never by the model: points over time are lines, a reading per label is a
   comparison, one reading is a number. */

export interface Point {
  at: number;
  value: number;
}

export type PlotUnit = "bytes";

export interface Line {
  label: string;
  points: Point[];
}

export type Plot =
  | {
      kind: "line";
      unit: PlotUnit | null;
      // Every series the query returned. Drawing one of five and saying nothing
      // is a chart that answers a question nobody asked.
      lines: Line[];
      // The metric every series here measures, which is one fact.
      metric: string;
      // Where the alert fired, when it falls inside the window drawn.
      alertAt: number | null;
    }
  | {
      kind: "bars";
      unit: PlotUnit | null;
      metric: string;
      bars: { label: string; value: number }[];
    }
  | { kind: "value"; label: string; unit: PlotUnit | null; value: number };

interface Series {
  metric: Record<string, string>;
  points: Point[];
}

// Enough to show the shape of a window without drawing a point per pixel.
const MAX_POINTS = 120;

function labelOf(metric: Record<string, string>): string {
  const name = metric["__name__"] ?? "series";
  const qualifier =
    metric["container"] ?? metric["pod"] ?? metric["job"] ?? metric["instance"];
  return qualifier ? `${name} (${qualifier})` : name;
}

/* When several series are drawn together the metric name is the same on all of
   them, so the label is what differs: the pod, the container, the instance. */
function seriesLabels(all: Series[]): string[] {
  const full = all.map((s) => labelOf(s.metric));
  if (all.length < 2) return full;
  const qualifiers = all.map(
    (s) =>
      s.metric["container"] ??
      s.metric["pod"] ??
      s.metric["instance"] ??
      s.metric["job"] ??
      null,
  );
  return qualifiers.every((q) => q !== null && q !== "")
    ? qualifiers.map((q) => q as string)
    : full;
}

// Prometheus names a metric for the unit it counts in, so the name is where the
// unit comes from. Without it a working set of 4272341811 draws as "4.3B",
// which is not 4 GB and is not caught at 02:14.
function unitOf(metric: Record<string, string>): PlotUnit | null {
  return /_bytes(_total)?$/.test(metric["__name__"] ?? "") ? "bytes" : null;
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
      ? [{ at: at * 1000, value: parsed }]
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
    const labels = seriesLabels(overTime);
    const firedAt = alert === null ? NaN : new Date(alert.firedAt).getTime();
    const times = overTime.flatMap((s) => s.points.map((p) => p.at));
    const inWindow =
      Number.isFinite(firedAt) &&
      firedAt >= Math.min(...times) &&
      firedAt <= Math.max(...times);
    return {
      kind: "line",
      unit: unitOf(overTime[0]!.metric),
      metric: overTime[0]!.metric["__name__"] ?? "series",
      lines: overTime.map((s, at) => ({
        label: labels[at] ?? labelOf(s.metric),
        points: downsample(s.points),
      })),
      alertAt: inWindow ? firedAt : null,
    };
  }

  // One reading each: there is no time axis to draw, so the comparison across
  // labels is the measurement, and a lone reading is just its number.
  if (series.length > 1) {
    const labels = seriesLabels(series);
    return {
      kind: "bars",
      metric: series[0]!.metric["__name__"] ?? "series",
      // Bars only compare readings of the same metric, so one unit covers them.
      unit: unitOf(series[0]!.metric),
      bars: series.map((s, at) => ({
        label: labels[at] ?? labelOf(s.metric),
        value: s.points[0]!.value,
      })),
    };
  }
  return {
    kind: "value",
    label: labelOf(series[0]!.metric),
    unit: unitOf(series[0]!.metric),
    value: series[0]!.points[0]!.value,
  };
}

function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* What a drawing is of, and what it cannot speak for, beneath the drawing where
   a caption goes. Never a heading above it: a heading has to be there for the
   layout to hold, and a caption may be absent without anything moving. */
export function plotCaption(plot: Plot): { of: string; scope: string } {
  if (plot.kind === "value") return { of: plot.label, scope: "" };
  if (plot.kind === "bars") {
    return { of: plot.metric, scope: `${plot.bars.length} series` };
  }
  const points = Math.max(...plot.lines.map((line) => line.points.length));
  const times = plot.lines.flatMap((line) => line.points.map((p) => p.at));
  const window = `${clockOf(Math.min(...times))}–${clockOf(Math.max(...times))}`;
  return {
    of: plot.metric,
    scope:
      plot.lines.length === 1
        ? `${points} points · ${window}`
        : `${plot.lines.length} series · ${points} points each · ${window}`,
  };
}
