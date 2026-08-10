import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { encrypt } from "../secrets.js";
import { savePrometheusIntegration } from "../db/integrations.js";
import { createSession } from "../db/sessions.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { parsedContent } from "./tool-result.js";
import type { MetricsRangeResult } from "../agent/tools/prometheus.js";
import type { Tool, ToolDispatchContext } from "../agent/tools/types.js";

const FIRED_AT = "2026-07-16T12:00:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: {},
  alertType: "OOMKill",
  severity: "critical",
  firedAt: FIRED_AT,
  annotations: {},
  generatorURL: null,
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

  function mintSession(...alerts: NormalizedAlert[]): ToolDispatchContext {
    sessionSeq++;
    const sessionId = `prom-tools-${sessionSeq}`;
    createSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alerts,
    );
    return {
      toolCallCeilingMs: 30_000,
      sessionId,
      toolUseId: `tu-${sessionSeq}`,
    };
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
    expect(result.outcome).toBe("permission");
    expect(result.content).toContain("not configured");
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
    expect(atAlert.outcome).toBeUndefined();
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
    expect(result.outcome).toBeUndefined();

    const params = mock.requests[0]!.params;
    // 180min back, 30min forward, 12600s window -> ceil(12600/200) = 63s step.
    expect(params.get("start")).toBe("2026-07-16T09:00:00.000Z");
    expect(params.get("end")).toBe("2026-07-16T12:30:00.000Z");
    expect(params.get("step")).toBe("63");
    const content = parsedContent<MetricsRangeResult>(result);
    expect(content.windowStart).toBe("2026-07-16T09:00:00.000Z");
    expect(content.windowEnd).toBe("2026-07-16T12:30:00.000Z");
    expect(content.stepSeconds).toBe(63);
  });

  it("anchors a batch on the earliest of them, since that is when it began", async () => {
    connect();
    // The window elects no primary, so anchoring on whichever arrived first
    // would put the window wherever ingest ordering happened to land it.
    const earlier: NormalizedAlert = {
      ...ALERT,
      sourceAlertId: "alert-0",
      firedAt: "2026-07-16T11:30:00.000Z",
    };
    await executeTool(range, { query: "up" }, mintSession(ALERT, earlier));

    const params = mock.requests[0]!.params;
    expect(params.get("start")).toBe("2026-07-16T08:30:00.000Z");
    expect(params.get("end")).toBe("2026-07-16T12:00:00.000Z");
  });

  it("chat sessions anchor on now, and the window never extends into the future", async () => {
    connect();
    await executeTool(range, { query: "up" }, mintSession());

    const params = mock.requests[0]!.params;
    const end = Date.parse(params.get("end")!);
    const start = Date.parse(params.get("start")!);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
    // The anchor and the future-clamp read the clock separately, so the window
    // is the lookback plus however long elapsed between the two reads.
    expect(end - start).toBeGreaterThanOrEqual(180 * 60_000);
    expect(end - start).toBeLessThan(180 * 60_000 + 5_000);
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
    const content = parsedContent<MetricsRangeResult>(result);
    expect(content.series).toHaveLength(20);
    expect(content.seriesOmitted).toBe(5);
  });

  /* Twenty series is a count, not a size: at the step this tool asks for, each
     carries around two hundred points, which is several times the ceiling. */
  it("drops whole series once twenty of them exceed the size budget", async () => {
    connect();
    mock.result = Array.from({ length: 20 }, (_, i) => ({
      metric: { name: `svc-${i}` },
      values: Array.from({ length: 200 }, (_, p): [number, string] => [
        1752667200 + p * 15,
        `${p}.5`,
      ]),
    }));
    const result = await executeTool(
      range,
      { query: "up" },
      mintSession(ALERT),
    );

    const content = parsedContent<MetricsRangeResult>(result);
    expect(content.series.length).toBeLessThan(20);
    expect(content.seriesOmitted).toBe(20 - content.series.length);
    // Each series that survived kept every point, so the shape it draws is the
    // one Prometheus returned rather than a truncated curve.
    for (const s of content.series) expect(s.values).toHaveLength(200);
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
    expect(result.outcome).toBe("system");
    expect(result.content).toContain("parse error");
  });

  /* Discovery, so an expression names a metric that exists. A PromQL query
     against a metric nobody exports returns no series, which reads as "the
     value is fine" rather than as a typo - the failure these tools remove. */
  describe("reading what Prometheus holds", () => {
    function installDiscoveryMock(payloads: Record<string, unknown>): void {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: unknown): Promise<Response> => {
          const url = String(input);
          const match = Object.keys(payloads).find((path) =>
            url.includes(path),
          );
          if (match === undefined) {
            throw new Error(`Unexpected Prometheus request in test: ${url}`);
          }
          return Promise.resolve(
            json({ status: "success", data: payloads[match] }),
          );
        }),
      );
    }

    it("narrows metric names by substring, case-insensitively", async () => {
      connect();
      installDiscoveryMock({
        "/api/v1/label/__name__/values": [
          "container_memory_working_set_bytes",
          "container_cpu_usage_seconds_total",
          "NODE_MEMORY_FREE_BYTES",
        ],
      });

      const result = await executeTool(
        findTool("ListMetricNames")!,
        { contains: "MeMoRy" },
        mintSession(ALERT),
      );
      const content = parsedContent<{ names: string[] }>(result);
      expect(content.names).toEqual([
        "container_memory_working_set_bytes",
        "NODE_MEMORY_FREE_BYTES",
      ]);
    });

    // A miss is the useful answer here: it says the name is wrong now, rather
    // than leaving an empty chart to say it later.
    it("says nothing matched rather than answering with an empty list", async () => {
      connect();
      installDiscoveryMock({ "/api/v1/label/__name__/values": ["up"] });

      const result = await executeTool(
        findTool("ListMetricNames")!,
        { contains: "nonesuch" },
        mintSession(ALERT),
      );
      expect(result.outcome).toBe("expected_miss");
      expect(result.content).toContain("No metric names matched");
    });

    it("reads a metric's type and unit, which is how a counter is told from a gauge", async () => {
      connect();
      installDiscoveryMock({
        "/api/v1/metadata": {
          container_memory_working_set_bytes: [
            { type: "gauge", unit: "bytes", help: "Current working set." },
          ],
        },
      });

      const result = await executeTool(
        findTool("GetMetricMetadata")!,
        { metric: "container_memory_working_set_bytes" },
        mintSession(ALERT),
      );
      expect(parsedContent(result)).toMatchObject({
        type: "gauge",
        unit: "bytes",
      });
    });

    // Absence of metadata says nothing about whether the metric exists, so it
    // must not read as "no such metric".
    it("distinguishes an undeclared metric from a missing one", async () => {
      connect();
      installDiscoveryMock({ "/api/v1/metadata": {} });

      const result = await executeTool(
        findTool("GetMetricMetadata")!,
        { metric: "custom_thing" },
        mintSession(ALERT),
      );
      expect(result.outcome).toBe("expected_miss");
      expect(result.content).toContain("may still exist");
    });

    it("lists alerting rules with the expression each one tests", async () => {
      connect();
      installDiscoveryMock({
        "/api/v1/rules": {
          groups: [
            {
              rules: [
                {
                  name: "ContainerMemoryHigh",
                  query: "container_memory_working_set_bytes > 4e9",
                  state: "firing",
                  alerts: [{ state: "firing", labels: {} }],
                },
                {
                  name: "DiskFilling",
                  query: "disk_free_bytes < 1e9",
                  state: "inactive",
                  alerts: [],
                },
              ],
            },
          ],
        },
      });

      const result = await executeTool(
        findTool("ListAlertRules")!,
        {},
        mintSession(ALERT),
      );
      const content = parsedContent<{
        rules: Array<{ name: string; query: string; firingCount: number }>;
      }>(result);
      expect(content.rules).toHaveLength(2);
      // The expression is the point: it names the metric, the threshold and the
      // window that fired, none of which the alert's labels carry.
      expect(content.rules[0]).toMatchObject({
        name: "ContainerMemoryHigh",
        query: "container_memory_working_set_bytes > 4e9",
        firingCount: 1,
      });
      expect(content.rules[1]!.firingCount).toBe(0);
    });

    it("offers every discovery tool a corrective result when nothing is connected", async () => {
      for (const name of [
        "ListMetricNames",
        "GetMetricMetadata",
        "ListAlertRules",
      ]) {
        const result = await executeTool(
          findTool(name)!,
          { metric: "x" },
          mintSession(ALERT),
        );
        expect(result.outcome).toBe("permission");
        expect(result.content).toContain("not configured");
      }
    });
  });
});
