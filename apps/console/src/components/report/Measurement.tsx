import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Plot, Point } from "./plot.js";

/* Hand-drawn SVG, no charting dependency: three shapes is not a library's worth
   of work, and the colours are the app's own tokens rather than a package's
   defaults. Nothing re-queries - every value comes from the recorded result, so
   a chart still draws after the metric's retention window has expired. */

const W = 640;
const H = 140;
const PAD = 8;

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Caption({
  left,
  right,
}: {
  left: string;
  right?: string;
}): React.JSX.Element {
  return (
    <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
      <span className="min-w-0">{left}</span>
      {right && <span className="shrink-0">{right}</span>}
    </figcaption>
  );
}

function Line({
  label,
  points,
}: {
  label: string;
  points: Point[];
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number): number =>
    PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number): number => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");

  return (
    <figure className="m-0 mt-2">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          className="w-full rounded-md border border-border bg-background"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const at = ((e.clientX - box.left) / box.width) * W;
            let nearest = 0;
            for (let i = 1; i < points.length; i++) {
              if (Math.abs(x(i) - at) < Math.abs(x(nearest) - at)) nearest = i;
            }
            setHover(nearest);
          }}
          onPointerLeave={() => setHover(null)}
        >
          {/* The line alone: a filled area under it reads as a volume, which a
              rate or a gauge is not, and it buries the axis it sits on. */}
          <polyline
            points={line}
            className="stroke-run fill-none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hover !== null && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD}
                y2={H - PAD}
                className="stroke-border-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {/* Ringed against the surface so the marker reads on the line. */}
              <circle
                cx={x(hover)}
                cy={y(values[hover]!)}
                r={4}
                className="fill-run stroke-background"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border border-border-strong bg-card px-2 py-1 font-mono text-sm whitespace-nowrap shadow-raised"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${(y(values[hover]!) / H) * 100}%`,
            }}
          >
            {compact.format(values[hover]!)} · {timeLabel(points[hover]!.at)}
          </div>
        )}
      </div>
      <Caption
        left={label}
        right={`${compact.format(min)}–${compact.format(max)} · ${timeLabel(points[0]!.at)}–${timeLabel(points[points.length - 1]!.at)}`}
      />
    </figure>
  );
}

// One reading per label has no time axis, so the comparison is the point. Bars
// are proportional to the largest, which is the only claim the data supports.
function Bars({
  bars,
}: {
  bars: { label: string; value: number }[];
}): React.JSX.Element {
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
      {bars.map((bar) => (
        <li key={bar.label} className="flex items-center gap-2">
          <span className="w-48 shrink-0 truncate font-mono text-sm text-muted-foreground">
            {bar.label}
          </span>
          <span
            aria-hidden="true"
            className="h-1.5 rounded-full bg-run"
            style={{ width: `${Math.max((bar.value / max) * 100, 1)}%` }}
          />
          <span className="shrink-0 font-mono text-sm tabular-nums">
            {compact.format(bar.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Measurement({ plot }: { plot: Plot }): React.JSX.Element {
  if (plot.kind === "line") {
    return <Line label={plot.label} points={plot.points} />;
  }
  if (plot.kind === "bars") return <Bars bars={plot.bars} />;
  return (
    <figure className="m-0 mt-2">
      <p className={cn("m-0 font-mono text-xl tabular-nums")}>
        {compact.format(plot.value)}
      </p>
      <Caption left={plot.label} />
    </figure>
  );
}
