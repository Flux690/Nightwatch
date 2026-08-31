/* What a cited result holds, read from its shape rather than its tool name. A
   tool that answers something else reads as nothing, and the caller falls back
   to its one-line reading. */

import { asRecord, numberAt, stringAt } from "@/shared/lib/toolResult";
import { compact } from "./format.js";
import { dayClock } from "@/shared/lib/time";
import { formatBytes } from "@/features/session/transcript/toolFindings";

// One server's answer inside a fan-out, or the result itself when there is no
// envelope. A server-routed tool is enveloped even for a single server.
interface Scoped {
  server: string | null;
  result: Record<string, unknown>;
}

function scopes(result: unknown): Scoped[] {
  const record = asRecord(result);
  if (record === null) return [];
  const fanned = record["byServer"];
  if (!Array.isArray(fanned)) return [{ server: null, result: record }];
  return fanned.flatMap((entry): Scoped[] => {
    const scoped = asRecord(entry);
    const inner = scoped === null ? null : asRecord(scoped["result"]);
    if (scoped === null || inner === null) return [];
    const server = stringAt(scoped, "server");
    return [{ server, result: inner }];
  });
}

// The payloads name their units in their field names. Nothing is inferred
// from a value: a bare number is printed as a number.
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

// Carried with its date rather than a bare clock: a config table holds when
// an image was built as well as when a container started, weeks apart.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function readable(value: string): string {
  const digest = DIGEST.exec(value);
  if (digest !== null) return `${digest[1]}:${digest[2]!.slice(0, 12)}…`;
  if (!ISO.test(value)) return value;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : dayClock(value);
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
  // The server this group answers for, or null when nothing fanned out.
  server: string | null;
  // `key` is the field the reading came from: two fields can read out under one
  // label once their units are stripped, and the field they came from cannot.
  rows: Array<{ key: string; label: string; value: string }>;
}

// Nothing is ranked: the one-line reading above already says which is the
// finding. Values nested in arrays stay with that line.
export function readingGroups(result: unknown): ReadingGroup[] {
  return scopes(result).flatMap((scope) => {
    const rows = Object.entries(scope.result).flatMap(([key, value]) =>
      typeof value === "number" && Number.isFinite(value)
        ? [{ key, label: label(key), value: readingOf(key, value) }]
        : [],
    );
    return rows.length === 0 ? [] : [{ server: scope.server, rows }];
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
    return rows.length === 0 ? [] : [{ server: scope.server, rows }];
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

// The shapes a logs result comes in: a runner's timestamped pairs, the kernel's
// levelled records, and Loki's streams. Plain strings are a runner before it
// stamped them, and a stored transcript still holds those.
function logLines(result: Record<string, unknown>): string[] {
  const lines = result["lines"];
  if (Array.isArray(lines)) {
    return lines.flatMap((line) => {
      if (typeof line === "string") return [line];
      const record = asRecord(line);
      if (record === null) return [];
      const text = stringAt(record, "line");
      if (text !== null) {
        const at = stringAt(record, "ts");
        return [at ? `${at} ${text}` : text];
      }
      const message = stringAt(record, "message");
      if (message === null) return [];
      const at = stringAt(record, "timestamp");
      return [[at, message].filter(Boolean).join(" ")];
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

// The tail, plus the worst line when it sits above that tail: an OOM kill four
// hundred lines back is the whole reason the claim cites this call.
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
