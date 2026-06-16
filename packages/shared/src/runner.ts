export interface CapabilityManifest {
  token: string;
  hostname: string;
  runnerVersion: string;
  capabilities: {
    docker: boolean;
    containers: string[];
    prometheus: { available: boolean; endpoint?: string };
    postgres: { available: boolean; via?: string };
    redis: { available: boolean; via?: string };
    hostMetrics: boolean;
    fileRead: boolean;
    remediationEnabled: boolean;
  };
}

export interface MetricSnapshot {
  token: string;
  capturedAt: string;
  metrics: Array<{
    containerName: string;
    memoryPercent: number;
    cpuPercent: number;
    restartCount: number;
    status: string;
  }>;
  host: {
    memoryPercent: number;
    diskPercent: Record<string, number>;
    loadAvg1m: number;
  };
}

export interface RunnerRecord {
  id: string;
  token: string;
  hostname: string | null;
  createdAt: string;
  online: boolean;
  lastSeen: string | null;
  manifest: CapabilityManifest | null;
}
