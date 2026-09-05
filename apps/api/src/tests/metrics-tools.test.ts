import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { saveMetricsSource } from "../integrations/metrics/store.js";
import { seedAlertSession } from "./session-helper.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { parsedContent } from "./tool-result.js";
import type { MetricsRangeResult } from "../agent/tools/metrics.js";
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

interface PromMock {
  requests: Array<{
    path: string;
    params: URLSearchParams;
    authorization: string | undefined;
  }>;
  result: unknown[];
  status: "success" | "error";
  error?: string;
  // The whole body, for the shapes `result` cannot express: a scalar, a
  // histogram, a warning beside the data, or a payload that has drifted.
  body?: unknown;
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

// Routes the two query endpoints the tools touch, failing loudly on any other.
// A signed AMP request arrives as a Request object, everything else as url+init.
function installPromMock(mock: PromMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const isRequest = input instanceof Request;
      const url = isRequest ? (input as Request).url : String(input);
      if (!url.includes("/api/v1/query")) {
        throw new Error(`Unexpected Prometheus request in test: ${url}`);
      }
      const body = isRequest
        ? await (input as Request).clone().text()
        : String(init?.body ?? "");
      const authorization = isRequest
        ? ((input as Request).headers.get("Authorization") ?? undefined)
        : (init?.headers as Record<string, string>)["Authorization"];
      mock.requests.push({
        path: url.slice(url.indexOf("/api/v1")),
        params: new URLSearchParams(body),
        authorization,
      });
      if (mock.status === "error") {
        return json(
          { status: "error", errorType: "bad_data", error: mock.error },
          400,
        );
      }
      if (mock.body !== undefined) return json(mock.body);
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

describe("metrics tools through the tool dispatch", () => {
  let cleanupDb: () => void;
  let instant: Tool;
  let range: Tool;
  let mock: PromMock;
  let sessionSeq = 0;

  async function toolContext(
    ...alerts: NormalizedAlert[]
  ): Promise<ToolDispatchContext> {
    sessionSeq++;
    const sessionId = `prom-tools-${sessionSeq}`;
    await seedAlertSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alerts,
    );
    return {
      toolCallCeilingMs: 30_000,
      sessionId,
      toolUseId: `tu-${sessionSeq}`,
    };
  }

  async function connect(
    over: Partial<Parameters<typeof saveMetricsSource>[0]> = {},
  ): Promise<void> {
    await saveMetricsSource({
      kind: "prometheus",
      label: "Prometheus",
      queryUrl: "http://prom.internal:9090",
      queryAuthorization: "Bearer tok",
      queryOrgId: null,
      rulesUrl: "http://prom.internal:9090",
      rulesAuthorization: "Bearer tok",
      rulesOrgId: null,
      ...over,
    });
  }

  beforeEach(async () => {
    cleanupDb = await useTempDb();
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
      await toolContext(ALERT),
    );
    expect(result.toolOutcome).toBe("permission");
    expect(result.content).toContain("No metrics source is connected");
    expect(mock.requests).toHaveLength(0);
  });

  it("instant query anchors at the alert when asked, at now by default, sending the header verbatim", async () => {
    await connect();
    mock.result = [
      { metric: { name: "api" }, value: [1752667200, "412000000"] },
    ];
    const ctx = await toolContext(ALERT);

    const atAlert = await executeTool(
      instant,
      { query: "up", at: "alert" },
      ctx,
    );
    expect(atAlert.toolOutcome).toBeUndefined();
    expect(mock.requests[0]!.path).toBe("/api/v1/query");
    expect(mock.requests[0]!.params.get("time")).toBe(FIRED_AT);
    expect(mock.requests[0]!.params.get("query")).toBe("up");
    expect(mock.requests[0]!.authorization).toBe("Bearer tok");

    await executeTool(instant, { query: "up" }, ctx);
    expect(mock.requests[1]!.params.get("time")).toBeNull();
  });

  it("signs an AMP query with SigV4 instead of sending a static header", async () => {
    await connect({
      kind: "amp",
      label: "AMP",
      queryUrl:
        "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-test",
      queryAuthorization: JSON.stringify({
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
      rulesUrl: null,
      rulesAuthorization: null,
    });
    mock.result = [{ metric: { name: "api" }, value: [1752667200, "1"] }];

    const result = await executeTool(
      instant,
      { query: "up" },
      await toolContext(ALERT),
    );

    expect(result.toolOutcome).toBeUndefined();
    expect(mock.requests[0]!.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/aps\/aws4_request/,
    );
  });

  it("range query windows around firedAt with an auto step, echoing the window in the result", async () => {
    await connect();
    const result = await executeTool(
      range,
      { query: "up" },
      await toolContext(ALERT),
    );
    // No series is a miss rather than a reading of zero: a metric that does not
    // exist answers identically, so the window is still echoed.
    expect(result.toolOutcome).toBe("expected_miss");

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
    await connect();
    // The window elects no primary, so anchoring on whichever arrived first
    // would put the window wherever ingest ordering happened to land it.
    const earlier: NormalizedAlert = {
      ...ALERT,
      sourceAlertId: "alert-0",
      firedAt: "2026-07-16T11:30:00.000Z",
    };
    await executeTool(
      range,
      { query: "up" },
      await toolContext(ALERT, earlier),
    );

    const params = mock.requests[0]!.params;
    expect(params.get("start")).toBe("2026-07-16T08:30:00.000Z");
    expect(params.get("end")).toBe("2026-07-16T12:00:00.000Z");
  });

  it("chat sessions anchor on now, and the window never extends into the future", async () => {
    await connect();
    await executeTool(range, { query: "up" }, await toolContext());

    const params = mock.requests[0]!.params;
    const end = Date.parse(params.get("end")!);
    const start = Date.parse(params.get("start")!);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
    // The anchor and the future-clamp read the clock separately, so the window
    // is the lookback plus however long elapsed between the two reads.
    expect(end - start).toBeGreaterThanOrEqual(180 * 60_000);
    expect(end - start).toBeLessThan(180 * 60_000 + 5_000);
  });

  /* Refused rather than quietly shortened: a window cut to a fraction of what
     was asked for reads back as a fortnight that held nothing. */
  it("refuses a lookback beyond 7 days and names the field", async () => {
    await connect();
    const result = await executeTool(
      range,
      { query: "up", lookbackMinutes: 999_999 },
      await toolContext(ALERT),
    );

    expect(String(result.content)).toMatch(/lookbackMinutes/);
    expect(result.toolOutcome).toBe("system");
    expect(mock.requests).toHaveLength(0);
  });

  it("caps the result at 20 series with an omitted count", async () => {
    await connect();
    mock.result = Array.from({ length: 25 }, (_, i) => ({
      metric: { name: `svc-${i}` },
      values: [[1752667200, "1"]],
    }));
    const result = await executeTool(
      range,
      { query: "up", lookbackMinutes: 10_080 },
      await toolContext(ALERT),
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
    await connect();
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
      await toolContext(ALERT),
    );

    const content = parsedContent<MetricsRangeResult>(result);
    expect(content.series.length).toBeLessThan(20);
    expect(content.seriesOmitted).toBe(20 - content.series.length);
    // Each series that survived kept every point, so the shape it draws is the
    // one Prometheus returned rather than a truncated curve.
    for (const s of content.series) expect(s.values).toHaveLength(200);
  });

  it("a rejected query becomes a corrective result naming the server's error, never a throw", async () => {
    await connect();
    mock.status = "error";
    mock.error = "parse error: unexpected identifier";
    const result = await executeTool(
      instant,
      { query: "up{" },
      await toolContext(ALERT),
    );
    expect(result.toolOutcome).toBe("system");
    expect(result.content).toContain("parse error");
  });

  // A query against a metric nobody exports returns no series, which reads as
  // "the value is fine" rather than as a typo.
  describe("reading what the source holds", () => {
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
      await connect();
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
        await toolContext(ALERT),
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
      await connect();
      installDiscoveryMock({ "/api/v1/label/__name__/values": ["up"] });

      const result = await executeTool(
        findTool("ListMetricNames")!,
        { contains: "nonesuch" },
        await toolContext(ALERT),
      );
      expect(result.toolOutcome).toBe("expected_miss");
      expect(result.content).toContain("No metric names matched");
    });

    it("reads a metric's type and unit, which is how a counter is told from a gauge", async () => {
      await connect();
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
        await toolContext(ALERT),
      );
      expect(parsedContent(result)).toMatchObject({
        type: "gauge",
        unit: "bytes",
      });
    });

    // Absence of metadata says nothing about whether the metric exists, so it
    // must not read as "no such metric".
    it("distinguishes an undeclared metric from a missing one", async () => {
      await connect();
      installDiscoveryMock({ "/api/v1/metadata": {} });

      const result = await executeTool(
        findTool("GetMetricMetadata")!,
        { metric: "custom_thing" },
        await toolContext(ALERT),
      );
      expect(result.toolOutcome).toBe("expected_miss");
      expect(result.content).toContain("may still exist");
    });

    it("lists alerting rules with the expression each one tests", async () => {
      await connect();
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
        await toolContext(ALERT),
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

    /* An empty answer the agent reads as healthy is what the result discipline
       exists against, and three supported sources cannot answer some calls. */
    describe("what a source cannot answer, said rather than shown as absence", () => {
      it("names VictoriaMetrics' missing metadata API instead of reporting the metric as undeclared", async () => {
        await connect({ kind: "victoriametrics", label: "vm" });

        const result = await executeTool(
          findTool("GetMetricMetadata")!,
          { metric: "container_memory_working_set_bytes" },
          await toolContext(ALERT),
        );

        expect(result.content).toContain("-enableMetadata");
        // The distinction that matters: this says nothing about the metric.
        expect(result.content).toContain("says nothing about whether");
        // Nor which of the two produced the emptiness.
        expect(result.content).toContain("which of those two");
        // Not asked at all - the answer is known before the call.
        expect(mock.requests).toHaveLength(0);
      });

      it("says a missing rules endpoint is a gap in the connection, not an absence of rules", async () => {
        await connect({ rulesUrl: null, rulesAuthorization: null });

        const result = await executeTool(
          findTool("ListAlertRules")!,
          {},
          await toolContext(ALERT),
        );

        expect(result.toolOutcome).toBe("permission");
        expect(result.content).toContain("not an absence of rules");
        expect(result.content).toContain("vmalert");
        expect(mock.requests).toHaveLength(0);
      });
    });

    /* One connection per product, so several sources means several products,
       each addressed by the product's own name. */
    it("offers every discovery tool a corrective result when nothing is connected", async () => {
      for (const name of [
        "ListMetricNames",
        "GetMetricMetadata",
        "ListAlertRules",
      ]) {
        const result = await executeTool(
          findTool(name)!,
          { metric: "x" },
          await toolContext(ALERT),
        );
        expect(result.toolOutcome).toBe("permission");
        expect(result.content).toContain("No metrics source is connected");
      }
    });
  });

  /* Payloads copied from Prometheus's own documented examples. The fakes above
     emit only the two shapes the client already read, so they agree by
     construction and could never have caught any of these. */
  describe("result shapes the Prometheus API documents", () => {
    it("reads a scalar as the one value it is, not as two empty series", async () => {
      await connect();
      mock.body = {
        status: "success",
        data: { resultType: "scalar", result: [1757100000, "3"] },
      };

      const result = await executeTool(
        instant,
        { query: "scalar(sum(up))" },
        await toolContext(ALERT),
      );

      const content = JSON.parse(result.content) as {
        resultType: string;
        series: Array<{ values: Array<[number, string]> }>;
      };
      expect(result.toolOutcome).toBeUndefined();
      expect(content.resultType).toBe("scalar");
      expect(content.series).toHaveLength(1);
      expect(content.series[0]!.values).toEqual([[1757100000, "3"]]);
    });

    it("names a native histogram instead of reporting it as no data", async () => {
      await connect();
      mock.body = {
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { __name__: "http_request_duration_seconds" },
              histograms: [
                [1757100000, { count: "60", sum: "120", buckets: [] }],
              ],
            },
          ],
        },
      };

      const result = await executeTool(
        range,
        { query: "http_request_duration_seconds" },
        await toolContext(ALERT),
      );

      const content = JSON.parse(result.content) as {
        series: Array<{ histogram?: true; values: Array<[number, string]> }>;
        note?: string;
      };
      expect(content.series[0]!.histogram).toBe(true);
      expect(content.series[0]!.values).toEqual([[1757100000, "60"]]);
      expect(content.note).toContain("histogram_quantile()");
    });

    it("reports a warning beside the data, since the read may be partial", async () => {
      await connect();
      mock.body = {
        status: "success",
        warnings: ["1 store failed: store-2 unreachable"],
        data: {
          resultType: "vector",
          result: [{ metric: { job: "api" }, value: [1757100000, "7"] }],
        },
      };

      const result = await executeTool(
        instant,
        { query: "up" },
        await toolContext(ALERT),
      );

      const content = JSON.parse(result.content) as { note?: string };
      expect(content.note).toContain("store-2 unreachable");
      expect(content.note).toContain("may be partial");
    });

    /* The pairing that hides a Thanos outage: a store is down, so nothing comes
       back, and the emptiness reads as a healthy zero unless the warning shows. */
    it("keeps the warning when the partial read returned nothing at all", async () => {
      await connect();
      mock.body = {
        status: "success",
        warnings: ["1 store failed: store-2 unreachable"],
        data: { resultType: "vector", result: [] },
      };

      const result = await executeTool(
        instant,
        { query: "up" },
        await toolContext(ALERT),
      );

      const content = JSON.parse(result.content) as { note: string };
      expect(result.toolOutcome).toBe("expected_miss");
      expect(content.note).toContain("store-2 unreachable");
      expect(content.note).toContain("not a reading of zero");
    });

    it("refuses a drifted payload rather than reading it as an empty result", async () => {
      await connect();
      // `result` renamed, which the field-by-field reading answered with [].
      mock.body = {
        status: "success",
        data: { resultType: "vector", results: [] },
      };

      const result = await executeTool(
        instant,
        { query: "up" },
        await toolContext(ALERT),
      );

      expect(result.toolOutcome).toBe("system");
      expect(result.content).toContain("shape this cannot read");
      expect(result.content).toContain("treat this as unknown");
    });
  });
});
