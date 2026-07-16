// LLM tool payload types for the host tools - matched to Anthropic
// TOOL_SCHEMAS in apps/api. Host facts come from the Docker runner only; a
// Kubernetes runner has no host to report on.

export interface HostMemoryResult {
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  oomKillerFiredRecently: boolean;
  oomKillerEvents: Array<{ timestamp: string; processName: string }>;
}

export interface HostCpuResult {
  cores: Array<{ id: number; usagePercent: number; iowaitPercent: number }>;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
  overallCpuPercent: number;
  overallIowaitPercent: number;
}

export interface HostDiskResult {
  filesystems: Array<{
    mount: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    usedPercent: number;
  }>;
  diskIO: Array<{
    device: string;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    iowaitPercent: number;
  }>;
}

export interface HostNetworkResult {
  listeningPorts: Array<{ port: number; protocol: string; process: string }>;
  connectionCounts: Array<{ state: string; count: number }>;
  totalConnections: number;
}

export interface HostDmesgInput {
  tailLines?: number;
  filterLevel?: "err" | "warn" | "all";
}
export interface HostDmesgResult {
  lines: Array<{ timestamp: string; level: string; message: string }>;
  oomEventsFound: boolean;
  fsErrorsFound: boolean;
}

export interface HostFileInput {
  path: string;
  maxLines?: number;
}
export interface HostFileResult {
  content: string;
  lineCount: number;
  path: string;
  redactedLineCount: number;
}
