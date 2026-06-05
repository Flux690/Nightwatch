import type { MetricSnapshot } from "@nightwatch/shared";

interface PrometheusRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      values: Array<[number, string]>;
    }>;
  };
}

const PROMETHEUS_URL = process.env["PROMETHEUS_URL"] ?? "http://localhost:9090";

export async function captureMetricSnapshot(
  token: string,
  runnerId: string,
  containerNames: string[],
): Promise<MetricSnapshot> {
  const capturedAt = new Date().toISOString();

  const [memResults, cpuResults, loadResult, diskResult] =
    await Promise.allSettled([
      prometheusQuery(
        `container_memory_usage_bytes{name=~"${containerNames.join("|")}"}`,
      ),
      prometheusQuery(
        `rate(container_cpu_usage_seconds_total{name=~"${containerNames.join("|")}"}[2m])`,
      ),
      prometheusQuery("node_load1"),
      prometheusQuery(
        "(node_filesystem_size_bytes - node_filesystem_free_bytes) / node_filesystem_size_bytes",
      ),
    ]);

  const memMap = extractLabelledValues(memResults, "name");
  const cpuMap = extractLabelledValues(cpuResults, "name");
  const loadVal = extractScalar(loadResult);
  const diskVal = extractScalar(diskResult);

  const metrics = containerNames.map((name) => ({
    containerName: name,
    memoryPercent: memMap[name] ?? 0,
    cpuPercent: (cpuMap[name] ?? 0) * 100,
    restartCount: 0,
    status: "running",
  }));

  return {
    token,
    runnerId,
    capturedAt,
    metrics,
    host: {
      memoryPercent: 0,
      diskPercent: { "/": diskVal * 100 },
      loadAvg1m: loadVal,
    },
  };
}

async function prometheusQuery(
  query: string,
): Promise<PrometheusRangeResponse> {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Prometheus ${res.status} for: ${query}`);
  return res.json() as Promise<PrometheusRangeResponse>;
}

function extractLabelledValues(
  settled: PromiseSettledResult<PrometheusRangeResponse>,
  labelKey: string,
): Record<string, number> {
  if (settled.status !== "fulfilled") return {};
  const result: Record<string, number> = {};
  for (const series of settled.value.data.result) {
    const key = series.metric[labelKey];
    const lastValue = series.values.at(-1);
    if (key && lastValue) result[key] = parseFloat(lastValue[1]);
  }
  return result;
}

function extractScalar(
  settled: PromiseSettledResult<PrometheusRangeResponse>,
): number {
  if (settled.status !== "fulfilled") return 0;
  const first = settled.value.data.result[0];
  const last = first?.values.at(-1);
  return last ? parseFloat(last[1]) : 0;
}
