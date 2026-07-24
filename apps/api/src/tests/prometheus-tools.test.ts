import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { encrypt } from "../config/crypto.js";
import { savePrometheusIntegration } from "../db/integrations.js";
import { createSession } from "../db/sessions.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import type { MetricsRangeResult } from "../agent/tools/prometheus.js";
import type { Tool, ToolExecuteContext } from "../agent/tools/types.js";

const FIRED_AT = "2026-07-16T12:00:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: {},
  targetIdentifier: { provider: "docker", project: "shop", service: "api" },
  alertType: "OOMKill",
  severity: "critical",
  firedAt: FIRED_AT,
  rawPayload: {},
};

interface PromMock {
  requests: Array<{
    path: string;
    params: URLSearchParams;
    authorization: string | undefined;
  }>;
  result: unknown[];
  status: "success" | "error";
  error?: string;
}

function makeMock(): PromMock {
  return { requests: [], result: [], status: "success" };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Routes the two query endpoints the tools touch; anything else fails loudly.
function installPromMock(mock: PromMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.includes("/api/v1/query")) {
        throw new Error(`Unexpected Prometheus request in test: ${url}`);
      }
      mock.requests.push({
        path: url.slice(url.indexOf("/api/v1")),
        params: new URLSearchParams(String(init?.body ?? "")),
        authorization: (init?.headers as Record<string, string>)[
          "Authorization"
        ],
      });
      if (mock.status === "error") {
        return json(
          { status: "error", errorType: "bad_data", error: mock.error },
          400,
        );
      }
      return json({
        status: "success",
        data: {
          resultType: url.endsWith("query_range") ? "matrix" : "vector",
          result: mock.result,
        },
      });
    }),
  );
}

describe("Prometheus tools through the tool dispatch", () => {
  let cleanupDb: () => void;
  let instant: Tool;
  let range: Tool;
  let mock: PromMock;
  let sessionSeq = 0;

  function mintSession(alert: NormalizedAlert | null): ToolExecuteContext {
    sessionSeq++;
    const sessionId = `prom-tools-${sessionSeq}`;
    createSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alert,
    );
    return { toolTimeoutMs: 30_000, sessionId, toolUseId: `tu-${sessionSeq}` };
  }

  function connect(): void {
    savePrometheusIntegration({
      baseUrl: "http://prom.internal:9090",
      authHeaderEncrypted: encrypt("Bearer tok"),
    });
  }

  beforeEach(() => {
    cleanupDb = useTempDb();
    mock = makeMock();
    installPromMock(mock);
    instant = findTool("QueryMetrics")!;
    range = findTool("QueryMetricsRange")!;
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllGlobals();
  });

  it("returns a corrective error without any request when not configured", async () => {
    const result = await executeTool(
      range,
      { query: "up" },
      mintSession(ALERT),
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("not configured");
    expect(mock.requests).toHaveLength(0);
  });

  it("instant query anchors at the alert when asked, at now by default, sending the header verbatim", async () => {
    connect();
    mock.result = [
      { metric: { name: "api" }, value: [1752667200, "412000000"] },
    ];
    const ctx = mintSession(ALERT);

    const atAlert = await executeTool(
      instant,
      { query: "up", at: "alert" },
      ctx,
    );
    expect(atAlert.is_error).toBeUndefined();
    expect(mock.requests[0]!.path).toBe("/api/v1/query");
    expect(mock.requests[0]!.params.get("time")).toBe(FIRED_AT);
    expect(mock.requests[0]!.params.get("query")).toBe("up");
    expect(mock.requests[0]!.authorization).toBe("Bearer tok");

    await executeTool(instant, { query: "up" }, ctx);
    expect(mock.requests[1]!.params.get("time")).toBeNull();
  });

  it("range query windows around firedAt with an auto step, echoing the window in the result", async () => {
    connect();
    const result = await executeTool(
      range,
      { query: "up" },
      mintSession(ALERT),
    );
    expect(result.is_error).toBeUndefined();

    const params = mock.requests[0]!.params;
    // 180min back, 30min forward, 12600s window -> ceil(12600/200) = 63s step.
    expect(params.get("start")).toBe("2026-07-16T09:00:00.000Z");
    expect(params.get("end")).toBe("2026-07-16T12:30:00.000Z");
    expect(params.get("step")).toBe("63");
    const content = result.content as MetricsRangeResult;
    expect(content.windowStart).toBe("2026-07-16T09:00:00.000Z");
    expect(content.windowEnd).toBe("2026-07-16T12:30:00.000Z");
    expect(content.stepSeconds).toBe(63);
  });

  it("chat sessions anchor on now, and the window never extends into the future", async () => {
    connect();
    await executeTool(range, { query: "up" }, mintSession(null));

    const params = mock.requests[0]!.params;
    const end = Date.parse(params.get("end")!);
    const start = Date.parse(params.get("start")!);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
    expect(end - start).toBe(180 * 60_000);
  });

  it("caps lookback at 7 days and the result at 20 series with an omitted count", async () => {
    connect();
    mock.result = Array.from({ length: 25 }, (_, i) => ({
      metric: { name: `svc-${i}` },
      values: [[1752667200, "1"]],
    }));
    const result = await executeTool(
      range,
      { query: "up", lookbackMinutes: 999_999 },
      mintSession(ALERT),
    );

    const params = mock.requests[0]!.params;
    const windowMs =
      Date.parse(params.get("end")!) - Date.parse(params.get("start")!);
    expect(windowMs).toBe((10_080 + 30) * 60_000);
    const content = result.content as MetricsRangeResult;
    expect(content.series).toHaveLength(20);
    expect(content.seriesOmitted).toBe(5);
  });

  it("a rejected query becomes a corrective result naming the server's error, never a throw", async () => {
    connect();
    mock.status = "error";
    mock.error = "parse error: unexpected identifier";
    const result = await executeTool(
      instant,
      { query: "up{" },
      mintSession(ALERT),
    );
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("parse error");
  });
});
