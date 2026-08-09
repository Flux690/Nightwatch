import { asRecord, numberAt as num, stringAt as str } from "@/lib/toolResult";

// The one-line answer a tool row shows unexpanded, COMPUTED from the tool's own
// structured result and never written by the model: a sentence it composes about
// data we already hold is one nothing can check. Quoted log lines stay verbatim.

type FindingTone = "normal" | "bad";

interface ToolFinding {
  text: string;
  tone: FindingTone;
}

// Runner errors arrive as a plain string with this prefix, not as a shaped
// object, so every formatter has to survive one.
const ERROR_PREFIX = "ERROR:";

function arr(record: Record<string, unknown>, key: string): unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

// Binary units, matching what docker stats and free report.
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded =
    value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

function formatPercent(value: number): string {
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

// One line of a log, clipped so a 400px rail shows the start of the message
// rather than an ellipsis where the interesting part was.
const LINE_CLIP = 120;

function quoteLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > LINE_CLIP
    ? `${trimmed.slice(0, LINE_CLIP)}…`
    : trimmed;
}

const SEVERE = /\b(error|err|fatal|panic|exception|traceback|oom)\b/i;
const WARNING = /\b(warn|warning)\b/i;

// Highest severity wins, and the line is returned as written. Choosing which
// line to show is a sort; rewording it would be a summary, which is the thing
// we are avoiding.
function worstLine(lines: string[]): { line: string; severe: boolean } | null {
  const severe = lines.find((l) => SEVERE.test(l));
  if (severe !== undefined) return { line: severe, severe: true };
  const warning = lines.find((l) => WARNING.test(l));
  if (warning !== undefined) return { line: warning, severe: false };
  const last = lines[lines.length - 1];
  return last === undefined ? null : { line: last, severe: false };
}

// A runner-routed result is always enveloped, even for one runner, so a formatter
// for such a tool reads the entries rather than the shape underneath. Entries whose
// runner failed carry an error string instead of a record and are skipped here.
function byRunner(
  record: Record<string, unknown>,
): Array<{ runner: string; result: Record<string, unknown> }> | null {
  const entries = arr(record, "byRunner");
  if (!entries) return null;
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { runner, result } = entry as Record<string, unknown>;
    if (typeof runner !== "string") return [];
    if (typeof result !== "object" || result === null) return [];
    return [{ runner, result: result as Record<string, unknown> }];
  });
}

type Formatter = (record: Record<string, unknown>) => ToolFinding | null;

const FORMATTERS: Record<string, Formatter> = {
  GetDockerLogs: (r) => {
    const lines = arr(r, "lines")?.filter(
      (l): l is string => typeof l === "string",
    );
    const total = num(r, "totalLines");
    if (!lines) return null;
    const counted =
      total !== null && total !== lines.length
        ? `${lines.length} of ${total}`
        : `${lines.length} lines`;
    if (lines.length === 0)
      return { text: "no matching lines", tone: "normal" };
    const worst = worstLine(lines);
    return worst === null
      ? { text: counted, tone: "normal" }
      : {
          text: `${quoteLine(worst.line)} · ${counted}`,
          tone: worst.severe ? "bad" : "normal",
        };
  },

  GetDockerStats: (r) => {
    const cpu = num(r, "cpuPercent");
    const used = num(r, "memoryUsedBytes");
    const limit = num(r, "memoryLimitBytes");
    if (cpu === null && used === null) return null;
    const parts: string[] = [];
    if (cpu !== null) parts.push(`cpu ${formatPercent(cpu)}`);
    if (used !== null) {
      parts.push(
        limit !== null && limit > 0
          ? `mem ${formatBytes(used)} of ${formatBytes(limit)}`
          : `mem ${formatBytes(used)}`,
      );
    }
    return { text: parts.join(" · "), tone: "normal" };
  },

  GetHostMemory: (record) => {
    // A fan-out answers for several runners at once. The worst reading is the
    // finding, and it is named, because "which host" is half the answer.
    const readings = byRunner(record);
    if (readings === null) return null;
    // Counted from the envelope, not from the readings: a runner that errored was
    // still asked, so its neighbour's answer still needs attributing.
    const fannedOut = (arr(record, "byRunner") ?? []).length > 1;

    const scored = readings.flatMap(({ runner, result }) => {
      const total = num(result, "totalBytes");
      const available = num(result, "availableBytes");
      if (total === null || available === null) return [];
      return [
        {
          runner,
          text: `${formatBytes(available)} free of ${formatBytes(total)}`,
          oom: result["oomKillerFiredRecently"] === true,
          freeRatio: total > 0 ? available / total : 1,
        },
      ];
    });

    // An OOM kill outranks any amount of free memory; below that, least free wins.
    const worst = scored.reduce<(typeof scored)[number] | null>(
      (acc, r) =>
        acc === null ||
        (r.oom && !acc.oom) ||
        (r.oom === acc.oom && r.freeRatio < acc.freeRatio)
          ? r
          : acc,
      null,
    );
    if (worst === null) return null;

    const named = fannedOut ? `${worst.runner}: ` : "";
    return worst.oom
      ? { text: `${named}OOM killer fired · ${worst.text}`, tone: "bad" }
      : { text: `${named}${worst.text}`, tone: "normal" };
  },

  GetDockerConfig: (r) => {
    const image = str(r, "image");
    const restart = str(r, "restartPolicy");
    if (image === null) return null;
    return {
      text: restart ? `${image} · restart ${restart}` : image,
      tone: "normal",
    };
  },

  GetDockerEvents: (r) => {
    const events = arr(r, "events");
    if (!events) return null;
    if (events.length === 0) return { text: "no events", tone: "normal" };
    const first = events[0];
    const label =
      typeof first === "object" && first !== null
        ? (str(first as Record<string, unknown>, "eventType") ?? "")
        : "";
    const count = `${events.length} event${events.length === 1 ? "" : "s"}`;
    return {
      text: label ? `${quoteLine(label)} · ${count}` : count,
      tone: "normal",
    };
  },
};

// A PR that opened renders as its own card, so this row is only ever reached by
// the outcome that did not: the message is the whole answer.
FORMATTERS["OpenPullRequest"] = (r) => {
  const message = str(r, "message");
  return message === null ? null : { text: quoteLine(message), tone: "normal" };
};

// Prometheus and Loki share a series shape, and an empty result is the finding
// that matters: it usually means the query named a metric that does not exist,
// which is otherwise invisible until the report has no chart in it.
function seriesFinding(record: Record<string, unknown>): ToolFinding | null {
  const series = arr(record, "series");
  if (!series) return null;
  if (series.length === 0) return { text: "no series matched", tone: "bad" };
  return {
    text: `${series.length} series`,
    tone: "normal",
  };
}

for (const name of [
  "QueryMetrics",
  "QueryMetricsRange",
  "QueryLogs",
  "QueryLogMetrics",
]) {
  FORMATTERS[name] = seriesFinding;
}

// Shell tools: exit status is the finding, and a non-zero exit is the failure
// the reader is scanning for.
function execFinding(record: Record<string, unknown>): ToolFinding | null {
  const exit = num(record, "exitCode");
  if (exit === null) return null;
  // The runner's container exec splits the streams; the repo sandbox's Bash
  // returns one combined `output`. Both reach this row.
  const stdout = str(record, "stdout") ?? str(record, "output") ?? "";
  const stderr = str(record, "stderr") ?? "";
  const lines = `${stdout}\n${stderr}`.split("\n").filter(Boolean).length;
  const counted = `${lines} line${lines === 1 ? "" : "s"}`;
  if (exit !== 0) {
    const firstErr = stderr.split("\n").find(Boolean);
    return {
      text: firstErr ? `exit ${exit} · ${quoteLine(firstErr)}` : `exit ${exit}`,
      tone: "bad",
    };
  }
  return { text: `exit 0 · ${counted}`, tone: "normal" };
}

for (const name of ["DockerBash", "K8sBash", "Bash"]) {
  FORMATTERS[name] = execFinding;
}

// null while the call is still running, and for any tool without a formatter:
// the row then shows its target alone rather than an invented summary.
export function findingFor(
  toolName: string,
  result: unknown,
): ToolFinding | null {
  if (result === null || result === undefined) return null;

  if (typeof result === "string" && result.startsWith(ERROR_PREFIX)) {
    const message = result.slice(ERROR_PREFIX.length).trim();
    const firstLine = message.split("\n").find(Boolean) ?? "failed";
    return { text: quoteLine(firstLine), tone: "bad" };
  }

  const record = asRecord(result);
  if (record === null) {
    if (typeof result !== "string") return null;
    const firstLine = result.split("\n").find(Boolean);
    return firstLine ? { text: quoteLine(firstLine), tone: "normal" } : null;
  }

  const formatter = FORMATTERS[toolName];
  return formatter ? formatter(record) : null;
}
