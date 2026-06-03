import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  GetHostCpuResult,
  GetHostDiskResult,
  GetHostDmesgInput,
  GetHostDmesgResult,
  GetHostMemoryResult,
  GetHostNetworkResult,
} from "@nightwatch/shared";

const exec = promisify(execFile);

export async function getHostMemory(): Promise<GetHostMemoryResult> {
  const [meminfo, dmesgOut] = await Promise.all([
    readFile("/proc/meminfo", "utf8"),
    exec("dmesg", ["-T"])
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const parseKb = (key: string): number => {
    const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1]!, 10) * 1024 : 0;
  };

  const total = parseKb("MemTotal");
  const available = parseKb("MemAvailable");
  const swapTotal = parseKb("SwapTotal");
  const swapFree = parseKb("SwapFree");

  const oomLines = dmesgOut
    .split("\n")
    .filter((l) => l.includes("Out of memory") || l.includes("oom-kill"));

  const oomKillerEvents = oomLines.map((line) => {
    const tsMatch = line.match(/\[([^\]]+)\]/);
    const procMatch = line.match(/process (\S+)/i) ?? line.match(/comm=(\S+)/i);
    return {
      timestamp: tsMatch ? tsMatch[1]! : new Date().toISOString(),
      processName: procMatch ? procMatch[1]! : "unknown",
    };
  });

  return {
    totalBytes: total,
    availableBytes: available,
    usedPercent: total > 0 ? ((total - available) / total) * 100 : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal - swapFree,
    oomKillerFiredRecently: oomKillerEvents.length > 0,
    oomKillerEvents: oomKillerEvents.slice(-10),
  };
}

export async function getHostCpu(): Promise<GetHostCpuResult> {
  const [stat1, loadavgStr] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile("/proc/loadavg", "utf8"),
  ]);

  // Two reads 100ms apart to compute delta
  await new Promise((r) => setTimeout(r, 100));
  const stat2 = await readFile("/proc/stat", "utf8");

  interface CpuRow {
    name: string;
    nums: number[];
  }

  const parseStat = (content: string): CpuRow[] =>
    content
      .split("\n")
      .filter((l) => l.startsWith("cpu"))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { name: parts[0]!, nums: parts.slice(1).map(Number) };
      });

  const s1 = parseStat(stat1);
  const s2 = parseStat(stat2);

  const computeUsage = (
    r1: CpuRow,
    r2: CpuRow,
  ): { usagePercent: number; iowaitPercent: number } => {
    const total =
      r2.nums.reduce((a, b) => a + b, 0) - r1.nums.reduce((a, b) => a + b, 0);
    const idle = (r2.nums[3] ?? 0) - (r1.nums[3] ?? 0);
    const iowait = (r2.nums[4] ?? 0) - (r1.nums[4] ?? 0);
    return {
      usagePercent: total > 0 ? ((total - idle) / total) * 100 : 0,
      iowaitPercent: total > 0 ? (iowait / total) * 100 : 0,
    };
  };

  const cores = s1.slice(1).map((c1, i) => {
    const c2 = s2[i + 1]!;
    const { usagePercent, iowaitPercent } = computeUsage(c1, c2);
    return { id: i, usagePercent, iowaitPercent };
  });

  const overall = computeUsage(s1[0]!, s2[0]!);
  const [la1, la5, la15] = loadavgStr.trim().split(/\s+/).map(Number);

  return {
    cores,
    loadAvg1m: la1 ?? 0,
    loadAvg5m: la5 ?? 0,
    loadAvg15m: la15 ?? 0,
    overallCpuPercent: overall.usagePercent,
    overallIowaitPercent: overall.iowaitPercent,
  };
}

export async function getHostDisk(): Promise<GetHostDiskResult> {
  const [dfOut, iostatOut] = await Promise.all([
    exec("df", ["-Bk"]).then((r) => r.stdout),
    exec("iostat", ["-x", "1", "1"])
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const filesystems: GetHostDiskResult["filesystems"] = dfOut
    .trim()
    .split("\n")
    .slice(1)
    .filter((l) => !l.startsWith("tmpfs") && !l.startsWith("udev"))
    .map((l) => {
      const cols = l.trim().split(/\s+/);
      const total = parseInt(cols[1] ?? "0", 10) * 1024;
      const used = parseInt(cols[2] ?? "0", 10) * 1024;
      return {
        device: cols[0] ?? "",
        totalBytes: total,
        usedBytes: used,
        usedPercent: total > 0 ? (used / total) * 100 : 0,
        mount: cols[5] ?? cols[cols.length - 1] ?? "/",
      };
    });

  const diskIO: GetHostDiskResult["diskIO"] = [];
  if (iostatOut) {
    const lines = iostatOut.split("\n");
    const headerIdx = lines.findIndex((l) => l.includes("Device"));
    if (headerIdx >= 0) {
      lines
        .slice(headerIdx + 1)
        .filter(Boolean)
        .forEach((l) => {
          const cols = l.trim().split(/\s+/);
          if (cols.length >= 7) {
            diskIO.push({
              device: cols[0] ?? "",
              readBytesPerSec: parseFloat(cols[5] ?? "0") * 1024,
              writeBytesPerSec: parseFloat(cols[6] ?? "0") * 1024,
              iowaitPercent: parseFloat(cols[cols.length - 1] ?? "0"),
            });
          }
        });
    }
  }

  return { filesystems, diskIO };
}

export async function getHostNetwork(): Promise<GetHostNetworkResult> {
  const { stdout } = await exec("ss", ["-tunapl"]);
  const lines = stdout.trim().split("\n").filter(Boolean);

  const listeningPorts: GetHostNetworkResult["listeningPorts"] = [];
  const stateCounts: Record<string, number> = {};
  let totalConnections = 0;

  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    const state = cols[1] ?? "";

    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    totalConnections++;

    if (state === "LISTEN" || state === "UNCONN") {
      const localAddr = cols[4] ?? "";
      const portStr = localAddr.split(":").pop() ?? "";
      const port = parseInt(portStr, 10);
      const procMatch = line.match(/\("([^"]+)",pid=(\d+)/);
      if (!isNaN(port)) {
        listeningPorts.push({
          port,
          protocol: cols[0] ?? "tcp",
          process: procMatch ? procMatch[1]! : "unknown",
        });
      }
    }
  }

  return {
    listeningPorts,
    connectionCounts: Object.entries(stateCounts).map(([state, count]) => ({
      state,
      count,
    })),
    totalConnections,
  };
}

export async function getHostDmesg(
  input: GetHostDmesgInput,
): Promise<GetHostDmesgResult> {
  const tailLines = input.tailLines ?? 100;
  const levelArg = input.filterLevel === "all" ? [] : ["--level", "err,warn"];

  const { stdout } = await exec("dmesg", ["-T", ...levelArg]).catch(async () =>
    exec("dmesg", ["-T"]),
  );

  const slice = stdout.trim().split("\n").filter(Boolean).slice(-tailLines);

  let oomEventsFound = false;
  let fsErrorsFound = false;

  const lines = slice.map((raw) => {
    const tsMatch = raw.match(/^\[([^\]]+)\]/);
    const message = tsMatch ? raw.slice(tsMatch[0].length).trim() : raw;

    if (message.includes("Out of memory") || message.includes("oom-kill"))
      oomEventsFound = true;
    if (
      message.includes("EXT4-fs error") ||
      message.includes("XFS") ||
      message.includes("I/O error")
    )
      fsErrorsFound = true;

    return {
      timestamp: tsMatch ? tsMatch[1]! : "",
      level: input.filterLevel ?? "err",
      message,
    };
  });

  return { lines, oomEventsFound, fsErrorsFound };
}
