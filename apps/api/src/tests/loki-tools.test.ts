import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { encrypt } from "../secrets.js";
import { saveLokiIntegration } from "../db/integrations.js";
import { createSession } from "../db/sessions.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
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
  severity: "critical",
  firedAt: FIRED_AT,
  rawPayload: {},
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

  function mintSession(alert: NormalizedAlert | null): ToolDispatchContext {
    sessionSeq++;
    const sessionId = `loki-tools-${sessionSeq}`;
    createSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alert,
    );
    return {
      toolCallCeilingMs: 30_000,
      sessionId,
      toolUseId: `tu-${sessionSeq}`,
    };
  }

  function connect(): void {
    saveLokiIntegration({
      baseUrl: "http://loki.internal:3100",
      orgId: "team-a",
      authHeaderEncrypted: encrypt("Bearer tok"),
    });
  }

  beforeEach(() => {
    cleanupDb = useTempDb();
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
      mintSession(ALERT),
    );
    expect(result.outcome).toBe("permission");
    expect(String(result.content)).toContain("not configured");
    expect(mock.requests).toHaveLength(0);
  });

  it("QueryLogs windows on firedAt newest-first, sends auth + tenant, parses lines to ISO", async () => {
    connect();
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
      mintSession(ALERT),
    );
    expect(result.outcome).toBeUndefined();

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

    const content = result.content as LokiLogsResult;
    expect(content.returnedLines).toBe(2);
    expect(content.streams[0]!.lines[0]).toEqual({
      ts: "2026-07-16T12:00:00.000Z",
      line: "line A",
    });
  });

  it("QueryLogs truncates an oversized line, flags the limit, and honors a custom limit", async () => {
    connect();
    const huge = "x".repeat(5000);
    mock.streams = [
      { stream: { app: "api" }, values: [["1752667200000000000", huge]] },
    ];
    const result = await executeTool(
      logs,
      { query: '{app="api"}', limit: 1 },
      mintSession(ALERT),
    );
    expect(mock.requests[0]!.params.get("limit")).toBe("1");
    const content = result.content as LokiLogsResult;
    expect(content.linesTruncated).toBe(1);
    expect(content.streams[0]!.lines[0]!.line).toContain("…[truncated]");
    expect(content.streams[0]!.lines[0]!.line.length).toBeLessThan(huge.length);
    expect(content.hitLimit).toBe(true);
    expect(content.note).toContain("truncated");
  });

  it("QueryLogMetrics sends a step (no direction) and caps at 20 series", async () => {
    connect();
    mock.matrix = Array.from({ length: 25 }, (_, i) => ({
      metric: { app: `svc-${i}` },
      values: [[1752667200, "1"]],
    }));
    const result = await executeTool(
      metrics,
      { query: 'sum(rate({app="api"}[5m]))' },
      mintSession(ALERT),
    );
    const req = mock.requests[0]!;
    expect(req.params.get("step")).not.toBeNull();
    expect(req.params.get("direction")).toBeNull();
    const content = result.content as LokiMetricsResult;
    expect(content.resultType).toBe("matrix");
    expect(content.series).toHaveLength(20);
    expect(content.seriesOmitted).toBe(5);
  });

  it("DiscoverLogLabels lists label names, values, and series, time-bounded to the alert", async () => {
    connect();
    mock.labels = ["app", "namespace"];
    const names = await executeTool(discover, {}, mintSession(ALERT));
    const namesContent = names.content as LogLabelsResult;
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
      mintSession(ALERT),
    );
    const valuesContent = values.content as LogLabelsResult;
    expect(valuesContent.mode).toBe("values");
    expect(valuesContent.label).toBe("app");
    expect(valuesContent.values).toEqual(["api", "worker"]);

    mock.series = [{ app: "api", namespace: "shop" }];
    const series = await executeTool(
      discover,
      { selector: '{namespace="shop"}' },
      mintSession(ALERT),
    );
    const seriesContent = series.content as LogLabelsResult;
    expect(seriesContent.mode).toBe("series");
    expect(seriesContent.matches).toEqual([{ app: "api", namespace: "shop" }]);
  });

  it("a rejected LogQL query becomes a corrective result, never a throw", async () => {
    connect();
    mock.status = "error";
    mock.errorText = "parse error at line 1: unexpected }";
    const result = await executeTool(logs, { query: "{" }, mintSession(ALERT));
    expect(result.outcome).toBe("system");
    expect(String(result.content)).toContain("parse error");
  });

  it("chat sessions anchor on now, and the window never extends into the future", async () => {
    connect();
    await executeTool(logs, { query: '{app="api"}' }, mintSession(null));
    const params = mock.requests[0]!.params;
    const end = nsToMs(params.get("end")!);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
  });
});
