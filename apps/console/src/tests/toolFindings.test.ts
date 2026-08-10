import { describe, it, expect } from "vitest";
import { findingFor } from "@/components/transcript/toolFindings";

// A corpus, not a set of examples: every shape below was captured from a real
// runner during the Redis OOM dry run. A formatter that drifts from the shape
// its tool actually returns fails here rather than silently rendering nothing.

describe("findingFor", () => {
  it("is null while a call is still running", () => {
    expect(findingFor("GetDockerLogs", null)).toBeNull();
  });

  describe("GetDockerLogs", () => {
    it("quotes the worst line verbatim and counts what was filtered", () => {
      const finding = findingFor("GetDockerLogs", {
        lines: [
          "1:C 26 Jul 2026 17:26:31.786 # WARNING Memory overcommit must be enabled!",
          "1:M 26 Jul 2026 17:39:41.020 # OOM command not allowed when used memory > 'maxmemory'",
        ],
        scannedLines: 66,
      });

      // The severe line wins over the warning, and it is quoted, not summarised.
      expect(finding?.text).toContain("OOM command not allowed");
      expect(finding?.text).toContain("2 of 66");
      expect(finding?.tone).toBe("bad");
    });

    // Naming the size of the search is the difference between "this service was
    // quiet" and "the words you asked for were not in the lines we read".
    it("says how much was searched when nothing matched", () => {
      const finding = findingFor("GetDockerLogs", {
        lines: [],
        scannedLines: 40,
      });
      expect(finding).toEqual({
        text: "no matches in 40 lines",
        tone: "normal",
      });
    });
  });

  it("GetDockerStats reads cpu and memory against the limit", () => {
    const finding = findingFor("GetDockerStats", {
      cpuPercent: 0.35468671679197994,
      memoryUsedBytes: 8101888,
      memoryLimitBytes: 8326942720,
      pids: 9,
    });
    expect(finding?.text).toBe("cpu 0.4% · mem 7.7 MB of 7.8 GB");
    expect(finding?.tone).toBe("normal");
  });

  describe("GetHostMemory", () => {
    // Runner-routed results are always enveloped, even for one runner.
    const envelope = (
      entries: Array<{ runner: string; result: unknown }>,
    ): unknown => ({ byRunner: entries });

    it("reports free against total, unqualified when one runner answered", () => {
      const finding = findingFor(
        "GetHostMemory",
        envelope([
          {
            runner: "prod-1",
            result: {
              totalBytes: 8326942720,
              availableBytes: 7025766400,
              usedPercent: 15.6,
              oomKillerFiredRecently: false,
            },
          },
        ]),
      );
      expect(finding?.text).toBe("6.5 GB free of 7.8 GB");
      expect(finding?.tone).toBe("normal");
    });

    it("names the worst host across a fan-out, since which host is half the answer", () => {
      const finding = findingFor(
        "GetHostMemory",
        envelope([
          {
            runner: "healthy-1",
            result: { totalBytes: 8326942720, availableBytes: 7025766400 },
          },
          {
            runner: "starved-2",
            result: { totalBytes: 8326942720, availableBytes: 83269427 },
          },
        ]),
      );
      expect(finding?.text).toContain("starved-2");
      expect(finding?.text).not.toContain("healthy-1");
    });

    it("leads with an OOM kill, because that is the whole answer", () => {
      const finding = findingFor(
        "GetHostMemory",
        envelope([
          {
            runner: "roomy-1",
            result: { totalBytes: 8326942720, availableBytes: 8000000000 },
          },
          {
            runner: "oom-2",
            result: {
              totalBytes: 8326942720,
              availableBytes: 8000000000,
              oomKillerFiredRecently: true,
            },
          },
        ]),
      );
      // An OOM kill outranks any amount of free memory.
      expect(finding?.text).toContain("oom-2");
      expect(finding?.text).toContain("OOM killer fired");
      expect(finding?.tone).toBe("bad");
    });

    it("reads the runners that answered, ignoring one that errored", () => {
      const finding = findingFor(
        "GetHostMemory",
        envelope([
          { runner: "down-1", result: "Error: timed out after 15000ms" },
          {
            runner: "up-2",
            result: { totalBytes: 8326942720, availableBytes: 7025766400 },
          },
        ]),
      );
      expect(finding?.text).toContain("up-2");
    });
  });

  it("GetDockerConfig names the image and restart policy", () => {
    const finding = findingFor("GetDockerConfig", {
      name: "encodr-cache-1",
      image: "redis:alpine",
      restartPolicy: "no",
      ports: ["6379/tcp"],
    });
    expect(finding?.text).toBe("redis:alpine · restart no");
  });

  it("GetDockerEvents names the first event and counts them", () => {
    const finding = findingFor("GetDockerEvents", {
      events: [
        {
          timestamp: "2026-07-26T17:39:38.000Z",
          eventType: "exec_create: redis-cli CONFIG SET maxmemory 1mb",
        },
        { timestamp: "2026-07-26T17:39:39.000Z", eventType: "exec_start" },
      ],
    });
    expect(finding?.text).toContain("CONFIG SET maxmemory 1mb");
    expect(finding?.text).toContain("2 events");
  });

  describe("metric and log queries", () => {
    // The dry run's charts were all missing because the model guessed a metric
    // name that does not exist. An empty series is the finding that says so.
    it("flags an empty series, the failure that otherwise looks like success", () => {
      const finding = findingFor("QueryMetricsRange", {
        resultType: "matrix",
        series: [],
        windowStart: "2026-07-26T17:10:00.584Z",
        stepSeconds: 60,
      });
      expect(finding).toEqual({ text: "no series matched", tone: "bad" });
    });

    it("counts series when the query matched", () => {
      const finding = findingFor("QueryMetrics", {
        resultType: "vector",
        series: [{ metric: {}, value: [1, "2"] }],
      });
      expect(finding?.text).toBe("1 series");
      expect(finding?.tone).toBe("normal");
    });
  });

  describe("shell tools", () => {
    // The runner's container exec splits the streams; the repo sandbox returns
    // one combined `output`. Both must read.
    it("reads split stdout/stderr from the runner", () => {
      const finding = findingFor("DockerBash", {
        exitCode: 0,
        stdout: "used_memory:1604216\nmaxmemory:1048576",
        stderr: "",
      });
      expect(finding?.text).toBe("exit 0 · 2 lines");
    });

    it("reads the sandbox's combined output", () => {
      const finding = findingFor("Bash", {
        exitCode: 0,
        output: "one\ntwo\nthree",
      });
      expect(finding?.text).toBe("exit 0 · 3 lines");
    });

    it("surfaces a non-zero exit with its first stderr line", () => {
      const finding = findingFor("DockerBash", {
        exitCode: 1,
        stdout: "",
        stderr: "redis-cli: connection refused",
      });
      expect(finding?.text).toBe("exit 1 · redis-cli: connection refused");
      expect(finding?.tone).toBe("bad");
    });
  });

  it("surfaces a runner error string as the finding", () => {
    const finding = findingFor(
      "GetHostDmesg",
      "ERROR: Error executing GetHostDmesg: Command failed: dmesg -T\ndmesg: read kernel buffer failed: Operation not permitted",
    );
    expect(finding?.text).toContain("Command failed: dmesg -T");
    expect(finding?.tone).toBe("bad");
  });

  it("falls back to the first line for a tool it has no formatter for", () => {
    expect(findingFor("SomeFutureTool", "all good\nsecond line")).toEqual({
      text: "all good",
      tone: "normal",
    });
  });

  it("returns null for an unknown tool with a shaped result, rather than guessing", () => {
    expect(findingFor("SomeFutureTool", { widgets: 3 })).toBeNull();
  });
});
