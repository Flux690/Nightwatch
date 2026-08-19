import { useState } from "react";
import { formatBytes } from "@/components/transcript/toolFindings";
import type { Line, Plot, PlotUnit } from "./plot.js";

/* Hand-drawn SVG, no charting dependency: the shapes are few and the colours
   are the app's own tokens. Nothing re-queries, so a chart still draws after
   the metric's retention window has expired. */

const W = 720;
const H = 240;
const PAD_L = 56;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 30;

// Six hues, then it repeats. A chart with more lines than that is read by its
// shape rather than by picking one line out, and the tooltip names them all.
const SERIES_HUES = 6;
const strokeOf = (at: number): string =>
  `var(--series-${(at % SERIES_HUES) + 1})`;

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Compact notation is only right for a count. A byte value read that way says
// "4.3B" for four gigabytes, so a metric that names its unit is read in it.
function readingIn(unit: PlotUnit | null): (value: number) => string {
  return unit === "bytes" ? formatBytes : (value) => compact.format(value);
}

function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Scale {
  x: (at: number) => number;
  y: (value: number) => number;
  min: number;
  max: number;
  t0: number;
  t1: number;
}

function scaleOf(lines: Line[]): Scale {
  const values = lines.flatMap((line) => line.points.map((p) => p.value));
  const times = lines.flatMap((line) => line.points.map((p) => p.at));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  // A flat series has no range to divide by, and a single instant no width.
  const span = max - min || 1;
  const window = t1 - t0 || 1;
  return {
    min,
    max,
    t0,
    t1,
    x: (at) => PAD_L + ((at - t0) / window) * (W - PAD_L - PAD_R),
    y: (value) => H - PAD_B - ((value - min) / span) * (H - PAD_T - PAD_B),
  };
}

/* The axes are the difference between a chart and a squiggle: without them the
   hover says 487 MB and nothing on screen says what the top of the box was. */
function Axes({
  scale,
  read,
}: {
  scale: Scale;
  read: (value: number) => string;
}): React.JSX.Element {
  const mid = (scale.min + scale.max) / 2;
  const ticks = [scale.max, mid, scale.min];
  const midTime = scale.t0 + (scale.t1 - scale.t0) / 2;
  return (
    <g>
      {ticks.map((value) => (
        <g key={value}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={scale.y(value)}
            y2={scale.y(value)}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={PAD_L - 8}
            y={scale.y(value) + 4}
            textAnchor="end"
            className="fill-ink-subtle font-mono text-[11px]"
          >
            {read(value)}
          </text>
        </g>
      ))}
      {[
        { at: scale.t0, anchor: "start" as const },
        { at: midTime, anchor: "middle" as const },
        { at: scale.t1, anchor: "end" as const },
      ].map(({ at, anchor }) => (
        <text
          key={at}
          x={scale.x(at)}
          y={H - 10}
          textAnchor={anchor}
          className="fill-ink-subtle font-mono text-[11px]"
        >
          {clockOf(at)}
        </text>
      ))}
    </g>
  );
}

// Where the alert fired, which is what makes the shape either side of it mean
// something. Drawn only from the alert's own timestamp; a threshold is not in
// any result we hold, so none is invented.
function AlertMark({
  at,
  scale,
}: {
  at: number;
  scale: Scale;
}): React.JSX.Element {
  return (
    <g>
      <line
        x1={scale.x(at)}
        x2={scale.x(at)}
        y1={PAD_T}
        y2={H - PAD_B}
        className="stroke-fail"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <text
        x={scale.x(at) + 5}
        y={PAD_T + 10}
        className="fill-fail font-mono text-[11px]"
      >
        alert {clockOf(at)}
      </text>
    </g>
  );
}

function LineChart({
  lines,
  unit,
  alertAt,
}: {
  lines: Line[];
  unit: PlotUnit | null;
  alertAt: number | null;
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const read = readingIn(unit);
  const scale = scaleOf(lines);

  // The point of each line nearest the hovered instant, so one crosshair
  // answers for every series rather than for whichever was drawn last.
  const atHover = lines.map((line) =>
    hover === null
      ? null
      : line.points.reduce((best, p) =>
          Math.abs(p.at - hover) < Math.abs(best.at - hover) ? p : best,
        ),
  );

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={lines.map((line) => line.label).join(", ")}
          className="w-full rounded-md border border-border bg-background"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const at = ((e.clientX - box.left) / box.width) * W;
            const ratio = (at - PAD_L) / (W - PAD_L - PAD_R);
            setHover(scale.t0 + ratio * (scale.t1 - scale.t0));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <Axes scale={scale} read={read} />
          {alertAt !== null && <AlertMark at={alertAt} scale={scale} />}
          {lines.map((line, at) => (
            <polyline
              key={line.label}
              points={line.points
                .map((p) => `${scale.x(p.at)},${scale.y(p.value)}`)
                .join(" ")}
              fill="none"
              stroke={strokeOf(at)}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover !== null && atHover[0] != null && (
            <g>
              <line
                x1={scale.x(atHover[0].at)}
                x2={scale.x(atHover[0].at)}
                y1={PAD_T}
                y2={H - PAD_B}
                className="stroke-border-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {atHover.map((point, at) =>
                point === null ? null : (
                  <circle
                    key={at}
                    cx={scale.x(point.at)}
                    cy={scale.y(point.value)}
                    r={3.5}
                    fill={strokeOf(at)}
                    className="stroke-background"
                    strokeWidth={2}
                  />
                ),
              )}
            </g>
          )}
        </svg>
        {hover !== null && atHover[0] != null && (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-border-strong bg-card px-2 py-1 font-mono text-sm whitespace-nowrap shadow-raised"
            style={{
              left: `${(scale.x(atHover[0].at) / W) * 100}%`,
              transform:
                scale.x(atHover[0].at) > W / 2
                  ? "translateX(-100%) translateX(-8px)"
                  : "translateX(8px)",
            }}
          >
            <p className="m-0 text-ink-subtle">{clockOf(atHover[0].at)}</p>
            {atHover.map((point, at) =>
              point === null ? null : (
                <p key={at} className="m-0 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ background: strokeOf(at) }}
                  />
                  {lines.length > 1 && (
                    <span className="text-muted-foreground">
                      {lines[at]!.label}
                    </span>
                  )}
                  <span className="tabular-nums">{read(point.value)}</span>
                </p>
              ),
            )}
          </div>
        )}
      </div>
      {lines.length > 1 && (
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
          {lines.map((line, at) => (
            <li
              key={line.label}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <span
                aria-hidden
                className="h-0.5 w-4 rounded-full"
                style={{ background: strokeOf(at) }}
              />
              <span className="font-mono">{line.label}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

// One reading per label has no time axis, so the comparison is the point. Bars
// are proportional to the largest, which is the only claim the data supports.
function Bars({
  unit,
  bars,
}: {
  unit: PlotUnit | null;
  bars: { label: string; value: number }[];
}): React.JSX.Element {
  const read = readingIn(unit);
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {bars.map((bar, at) => (
        <li key={bar.label} className="flex items-center gap-3">
          <span className="w-48 shrink-0 truncate font-mono text-sm text-muted-foreground">
            {bar.label}
          </span>
          <span className="flex min-w-0 flex-1 items-center">
            <span
              aria-hidden
              className="h-2 rounded-full"
              style={{
                width: `${Math.max((bar.value / max) * 100, 1)}%`,
                background: strokeOf(at),
              }}
            />
          </span>
          <span className="w-24 shrink-0 text-right font-mono text-sm tabular-nums">
            {read(bar.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Measurement({ plot }: { plot: Plot }): React.JSX.Element {
  if (plot.kind === "line") {
    return (
      <LineChart lines={plot.lines} unit={plot.unit} alertAt={plot.alertAt} />
    );
  }
  if (plot.kind === "bars") return <Bars unit={plot.unit} bars={plot.bars} />;
  return (
    <p className="m-0 font-mono text-xl tabular-nums">
      {readingIn(plot.unit)(plot.value)}
    </p>
  );
}
