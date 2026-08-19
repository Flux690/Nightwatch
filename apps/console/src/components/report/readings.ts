import { asRecord, numberAt, stringAt } from "@/lib/toolResult";
import { formatBytes } from "@/components/transcript/toolFindings";

/* What a cited result holds, read from its shape rather than its tool name: the
   declared kind already says what to draw, and these say where the numbers and
   the lines are. A tool that answers something else reads as nothing, which the
   caller renders as its one-line reading instead. */

// One runner's answer inside a fan-out, or the result itself when there is no
// envelope. A fleet tool is enveloped even for a single runner.
interface Scoped {
  runner: string | null;
  result: Record<string, unknown>;
}

function scopes(result: unknown): Scoped[] {
  const record = asRecord(result);
  if (record === null) return [];
  const fanned = record["byRunner"];
  if (!Array.isArray(fanned)) return [{ runner: null, result: record }];
  return fanned.flatMap((entry): Scoped[] => {
    const scoped = asRecord(entry);
    const inner = scoped === null ? null : asRecord(scoped["result"]);
    if (scoped === null || inner === null) return [];
    const runner = stringAt(scoped, "runner");
    return [{ runner, result: inner }];
  });
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/* The payloads name their own units in their field names, which is the same
   convention plot.ts reads a metric name for. Nothing is inferred from a value:
   a bare number is printed as a number. */
function readingOf(key: string, value: number): string {
  if (/bytes$/i.test(key)) return formatBytes(value);
  if (/percent$/i.test(key)) {
    return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
  }
  return compact.format(value);
}

/* A content-addressed digest, whatever field it arrives in. Shown the length
   `docker images` shows it: enough to tell two builds apart, and the rest is
   sixty characters nobody reads dominating every row beside it. */
const DIGEST = /^([a-z0-9]+):([0-9a-f]{32,})$/;

/* An instant, however it arrived. Carried with its date rather than as a bare
   clock: a config table holds when an image was built as well as when a
   container started, and those can be weeks apart. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function readable(value: string): string {
  const digest = DIGEST.exec(value);
  if (digest !== null) return `${digest[1]}:${digest[2]!.slice(0, 12)}…`;
  if (!ISO.test(value)) return value;
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

// memoryUsedBytes -> "memory used". The unit is carried by the value, so
// repeating it in the label says the same thing twice.
function label(key: string): string {
  return key
    .replace(/(Bytes|Percent)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

export interface ReadingGroup {
  // The runner this group answers for, or null when nothing fanned out.
  runner: string | null;
  // `key` is the field the reading came from: two fields can read out under one
  // label once their units are stripped, and the field they came from cannot.
  rows: Array<{ key: string; label: string; value: string }>;
}

/* Every top-level number a result carries, in the order it carries them.
   Nothing is selected and nothing is ranked: the one-line reading above already
   says which of them is the finding. Values nested in arrays - a pod, a
   filesystem, a core - are not read here and stay with that line. */
export function readingGroups(result: unknown): ReadingGroup[] {
  return scopes(result).flatMap((scope) => {
    const rows = Object.entries(scope.result).flatMap(([key, value]) =>
      typeof value === "number" && Number.isFinite(value)
        ? [{ key, label: label(key), value: readingOf(key, value) }]
        : [],
    );
    return rows.length === 0 ? [] : [{ runner: scope.runner, rows }];
  });
}

/* The same, for what a state result says about itself: strings as well as
   numbers, since an image tag and a restart count are one fact together. */
export function stateGroups(result: unknown): ReadingGroup[] {
  return scopes(result).flatMap((scope) => {
    const rows = Object.entries(scope.result).flatMap(([key, value]) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return [{ key, label: label(key), value: readingOf(key, value) }];
      }
      return typeof value === "string" && value !== ""
        ? [{ key, label: label(key), value: readable(value) }]
        : [];
    });
    return rows.length === 0 ? [] : [{ runner: scope.runner, rows }];
  });
}

/* A result that carries a series has said where its measurement is, so an empty
   one means the query matched nothing - not that the window and step it echoes
   back are the reading. */
export function carriesSeries(result: unknown): boolean {
  const record = asRecord(result);
  return record !== null && Array.isArray(record["series"]);
}

export interface LogExcerpt {
  lines: string[];
  // The line the excerpt is anchored on, when a severe one sits outside it.
  worstAbove: string | null;
  // How many the tool returned, so a five-line excerpt never reads as the whole.
  returned: number;
}

const SEVERE = /\b(error|err|fatal|panic|exception|traceback|oom)\b/i;
const WARNING = /\b(warn|warning)\b/i;
const EXCERPT_LINES = 5;

export function isSevere(line: string): boolean {
  return SEVERE.test(line);
}

export function isWarning(line: string): boolean {
  return !SEVERE.test(line) && WARNING.test(line);
}

// The three shapes a logs result comes in: plain strings from a runner, the
// kernel's levelled records, and Loki's streams of timestamped lines.
function logLines(result: Record<string, unknown>): string[] {
  const lines = result["lines"];
  if (Array.isArray(lines)) {
    return lines.flatMap((line) => {
      if (typeof line === "string") return [line];
      const record = asRecord(line);
      if (record === null) return [];
      const message = stringAt(record, "message");
      if (message === null) return [];
      const at = stringAt(record, "timestamp");
      const level = stringAt(record, "level");
      return [[at, level, message].filter(Boolean).join(" ")];
    });
  }
  const streams = result["streams"];
  if (!Array.isArray(streams)) return [];
  return streams.flatMap((stream) => {
    const record = asRecord(stream);
    const entries = record === null ? null : record["lines"];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const line = asRecord(entry);
      if (line === null) return [];
      const text = stringAt(line, "line");
      if (text === null) return [];
      const ts = stringAt(line, "ts");
      return [ts === null ? text : `${ts} ${text}`];
    });
  });
}

/* The tail, because a log is read from its end, plus the worst line when it
   sits above that tail: an OOM kill four hundred lines back is the whole
   reason the claim cites this call. */
export function logExcerpt(result: unknown): LogExcerpt | null {
  const all = scopes(result).flatMap((scope) => logLines(scope.result));
  if (all.length === 0) return null;

  const lines = all.slice(-EXCERPT_LINES);
  const worst =
    all.find(isSevere) ?? all.find((line) => isWarning(line)) ?? null;
  return {
    lines,
    worstAbove: worst !== null && !lines.includes(worst) ? worst : null,
    returned: all.length,
  };
}

// How many lines the tool actually searched, which is what makes a small match
// count mean anything. Absent on a source that does not report it.
export function scannedLines(result: unknown): number | null {
  const record = asRecord(result);
  return record === null ? null : numberAt(record, "scannedLines");
}
