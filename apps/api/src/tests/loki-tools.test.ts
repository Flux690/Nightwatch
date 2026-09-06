import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAlertSession } from "./session-helper.js";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { saveLokiIntegration } from "../integrations/store.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { parsedContent } from "./tool-result.js";
import type {
  LokiLogsResult,
  LokiMetricsResult,
  LogLabelsResult,
} from "../agent/tools/loki.js";
import type { Tool, ToolDispatchContext } from "../agent/tools/types.js";

const FIRED_AT = "2026-07-16T12:00:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: {},
  alertType: "OOMKill",
  firedAt: FIRED_AT,
  annotations: {},
  generatorURL: null,
  values: {},
};

interface LokiMock {
  requests: Array<{
    path: string;
    params: URLSearchParams;
    authorization: string | undefined;
    orgId: string | undefined;
  }>;
  streams: unknown[];
  matrix: unknown[];
  // The whole body, for a payload that has drifted from what Loki documents.
  body?: unknown;
  labels: string[];
  values: string[];
  series: unknown[];
  status: "success" | "error";
  errorText?: string;
}

function makeMock(): LokiMock {
  return {
    requests: [],
    streams: [],
    matrix: [],
    labels: [],
    values: [],
    series: [],
    status: "success",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installLokiMock(mock: LokiMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const parsed = new URL(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const params = init?.body
        ? new URLSearchParams(String(init.body))
        : parsed.searchParams;
      mock.requests.push({
        path: parsed.pathname,
        params,
        authorization: headers["Authorization"],
        orgId: headers["X-Scope-OrgID"],
      });

      if (url.includes("/loki/api/v1/query_range")) {
        if (mock.status === "error") {
          return new Response(mock.errorText ?? "parse error", { status: 400 });
        }
        if (mock.body !== undefined) return json(mock.body);
        // QueryLogs sends direction; QueryLogMetrics sends step.
        const isLogs = params.get("direction") !== null;
        return json({
          status: "success",
          data: isLogs
            ? { resultType: "streams", result: mock.streams }
            : { resultType: "matrix", result: mock.matrix },
        });
      }
      if (url.includes("/loki/api/v1/label/")) {
        return json({ status: "success", data: mock.values });
      }
      if (url.includes("/loki/api/v1/labels")) {
        return json({ status: "success", data: mock.labels });
      }
      if (url.includes("/loki/api/v1/series")) {
        return json({ status: "success", data: mock.series });
      }
      throw new Error(`Unexpected Loki request in test: ${url}`);
    }),
  );
}

function nsToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}

describe("Loki tools through the tool dispatch", () => {
  let cleanupDb: () => void;
  let logs: Tool;
  let metrics: Tool;
  let discover: Tool;
  let mock: LokiMock;
  let sessionSeq = 0;

  async function toolContext(
    alert: NormalizedAlert | null,
  ): Promise<ToolDispatchContext> {
    sessionSeq++;
    const sessionId = `loki-tools-${sessionSeq}`;
    await seedAlertSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alert ? [alert] : [],
    );
    return {
      toolCallCeilingMs: 30_000,
      sessionId,
      toolCallId: `tu-${sessionSeq}`,
    };
  }

  async function connect(): Promise<void> {
    await saveLokiIntegration({
      baseUrl: "http://loki.internal:3100",
      orgId: "team-a",
      authorization: "Bearer tok",
    });
  }

  beforeEach(async () => {
    cleanupDb = await useTempDb();
    mock = makeMock();
    installLokiMock(mock);
    logs = findTool("QueryLogs")!;
    metrics = findTool("QueryLogMetrics")!;
    discover = findTool("DiscoverLogLabels")!;
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllGlobals();
  });

  it("returns a corrective error without any request when not configured", async () => {
    const result = await executeTool(
      logs,
      { query: '{app="api"}' },
      await toolContext(ALERT),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
    expect(mock.requests).toHaveLength(0);
  });

  it("QueryLogs windows on firedAt newest-first, sends auth + tenant, parses lines to ISO", async () => {
    await connect();
    const firedNs = (BigInt(Date.parse(FIRED_AT)) * 1_000_000n).toString();
    const earlierNs = (
      BigInt(Date.parse(FIRED_AT) - 60_000) * 1_000_000n
    ).toString();
    mock.streams = [
      {
        stream: { app: "api" },
        values: [
          [firedNs, "line A"],
          [earlierNs, "line B"],
        ],
      },
    ];
    const result = await executeTool(
      logs,
      { query: '{app="api"} |= "error"' },
      await toolContext(ALERT),
    );
    expect(result.isError).toBeUndefined();

    const req = mock.requests[0]!;
    expect(req.path).toBe("/loki/api/v1/query_range");
    expect(req.authorization).toBe("Bearer tok");
    expect(req.orgId).toBe("team-a");
    expect(req.params.get("direction")).toBe("backward");
    expect(req.params.get("limit")).toBe("100");
    expect(req.params.get("query")).toBe('{app="api"} |= "error"');
    // 60min back, 5min forward from firedAt.
    expect(nsToMs(req.params.get("start")!)).toBe(
      Date.parse("2026-07-16T11:00:00.000Z"),
    );
    expect(nsToMs(req.params.get("end")!)).toBe(
      Date.parse("2026-07-16T12:05:00.000Z"),
    );

    const content = parsedContent<LokiLogsResult>(result);
    expect(content.returnedLines).toBe(2);
    expect(content.streams[0]!.lines[0]).toEqual({
      ts: "2026-07-16T12:00:00.000Z",
      line: "line A",
    });
  });

  it("QueryLogs truncates an oversized line, flags the limit, and honors a custom limit", async () => {
    await connect();
    const huge = "x".repeat(5000);
    mock.streams = [
      { stream: { app: "api" }, values: [["1752667200000000000", huge]] },
    ];
    const result = await executeTool(
      logs,
      { query: '{app="api"}', limit: 1 },
      await toolContext(ALERT),
    );
    expect(mock.requests[0]!.params.get("limit")).toBe("1");
    const content = parsedContent<LokiLogsResult>(result);
    expect(content.linesTruncated).toBe(1);
    expect(content.streams[0]!.lines[0]!.line).toContain(
      "[cut: line continues]",
    );
    expect(content.streams[0]!.lines[0]!.line.length).toBeLessThan(huge.length);
    expect(content.hitLimit).toBe(true);
    expect(content.note).toContain("truncated");
  });

  /* The per-line cap bounds no total, so a legal 100-line answer of capped lines
     is 200KB riding in context for the rest of the run. Lines share a budget. */
  it("QueryLogs stops at the budget and says what is missing from the result", async () => {
    await connect();
    // Each line is legal on its own; together they are several times the budget.
    mock.streams = [
      {
        stream: { app: "api" },
        values: Array.from({ length: 100 }, (_, i): [string, string] => [
          `${1752667200 + i}000000000`,
          `${i} ${"e".repeat(1_500)}`,
        ]),
      },
    ];
    const result = await executeTool(
      logs,
      { query: '{app="api"}' },
      await toolContext(ALERT),
    );

    const content = parsedContent<LokiLogsResult>(result);
    expect(content.linesDropped).toBeGreaterThan(0);
    expect(content.returnedLines + content.linesDropped).toBe(100);
    // The lines that did arrive are whole, and the model is told the rest exist
    // rather than being left to read the shortfall as "there were no more".
    for (const line of content.streams[0]!.lines) {
      expect(line.line).not.toContain("[cut: line continues]");
    }
    expect(content.note).toContain("NOT in this result");
    expect(content.note).toContain("QueryLogMetrics");
    // The cursor it hands back is the oldest line it returned, so continuing
    // from it reads the next ones down rather than skipping any.
    const oldest = content.streams[0]!.lines.at(-1)!.ts;
    expect(content.note).toContain(`until="${oldest}"`);
  });

  /* The window is anchored on the alert and lookforwardMinutes cannot go
     negative, so without this every repeat returns the same newest lines. */
  it("QueryLogs aims the window at until instead of the alert", async () => {
    await connect();
    await executeTool(
      logs,
      {
        query: '{app="api"}',
        until: "2026-07-16T11:23:00.000Z",
        lookbackMinutes: 30,
      },
      await toolContext(ALERT),
    );

    const params = mock.requests[0]!.params;
    expect(nsToMs(params.get("end")!)).toBe(
      Date.parse("2026-07-16T11:23:00.000Z"),
    );
    // The whole window moves rather than shrinking from the right, so a walk
    // backward covers new ground on every call.
    expect(nsToMs(params.get("start")!)).toBe(
      Date.parse("2026-07-16T10:53:00.000Z"),
    );
  });

  it("QueryLogs corrects an until that is not a timestamp", async () => {
    await connect();
    const result = await executeTool(
      logs,
      { query: '{app="api"}', until: "last tuesday" },
      await toolContext(ALERT),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ISO 8601");
    // Corrected before any request: a bad window is not Loki's to answer.
    expect(mock.requests).toHaveLength(0);
  });

  it("QueryLogMetrics sends a step (no direction) and caps at 20 series", async () => {
    await connect();
    mock.matrix = Array.from({ length: 25 }, (_, i) => ({
      metric: { app: `svc-${i}` },
      values: [[1752667200, "1"]],
    }));
    const result = await executeTool(
      metrics,
      { query: 'sum(rate({app="api"}[5m]))' },
      await toolContext(ALERT),
    );
    const req = mock.requests[0]!;
    expect(req.params.get("step")).not.toBeNull();
    expect(req.params.get("direction")).toBeNull();
    const content = parsedContent<LokiMetricsResult>(result);
    expect(content.resultType).toBe("matrix");
    expect(content.series).toHaveLength(20);
    expect(content.seriesOmitted).toBe(5);
  });

  it("DiscoverLogLabels lists label names, values, and series, time-bounded to the alert", async () => {
    await connect();
    mock.labels = ["app", "namespace"];
    const names = await executeTool(discover, {}, await toolContext(ALERT));
    const namesContent = parsedContent<LogLabelsResult>(names);
    expect(namesContent.mode).toBe("labels");
    expect(namesContent.labels).toEqual(["app", "namespace"]);
    // Discovery is bounded to a window around the alert, not all of time.
    const labelReq = mock.requests[0]!;
    expect(nsToMs(labelReq.params.get("start")!)).toBe(
      Date.parse("2026-07-16T11:00:00.000Z"),
    );

    mock.values = ["api", "worker"];
    const values = await executeTool(
      discover,
      { label: "app" },
      await toolContext(ALERT),
    );
    const valuesContent = parsedContent<LogLabelsResult>(values);
    expect(valuesContent.mode).toBe("values");
    expect(valuesContent.label).toBe("app");
    expect(valuesContent.values).toEqual(["api", "worker"]);

    mock.series = [{ app: "api", namespace: "shop" }];
    const series = await executeTool(
      discover,
      { selector: '{namespace="shop"}' },
      await toolContext(ALERT),
    );
    const seriesContent = parsedContent<LogLabelsResult>(series);
    expect(seriesContent.mode).toBe("series");
    expect(seriesContent.matches).toEqual([{ app: "api", namespace: "shop" }]);
  });

  it("a rejected LogQL query becomes a corrective result, never a throw", async () => {
    await connect();
    mock.status = "error";
    mock.errorText = "parse error at line 1: unexpected }";
    const result = await executeTool(
      logs,
      { query: "{" },
      await toolContext(ALERT),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("parse error");
  });

  it("chat sessions anchor on now, and the window never extends into the future", async () => {
    await connect();
    await executeTool(logs, { query: '{app="api"}' }, await toolContext(null));
    const params = mock.requests[0]!.params;
    const end = nsToMs(params.get("end")!);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
  });

  /* The mock above emits only the shapes the client already read, so it agrees
     with it by construction. This is the case neither side would have caught. */
  it("refuses a drifted payload rather than reading it as no log lines", async () => {
    await connect();
    // `stream` renamed, which the field-by-field reading answered with [].
    mock.body = {
      status: "success",
      data: {
        resultType: "streams",
        result: [{ labels: { app: "api" }, values: [["1757100000000", "x"]] }],
      },
    };

    const result = await executeTool(
      logs,
      { query: '{app="api"}' },
      await toolContext(null),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("shape this cannot read");
    expect(result.content).toContain("treat this as unknown");
  });
});
