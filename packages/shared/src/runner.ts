export interface CapabilityManifest {
  runnerId: string;
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
  runnerId: string;
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

export interface DashboardQuery {
  type:
    | "get_incident_history"
    | "get_incident_detail"
    | "get_current_infrastructure_state"
    | "get_metric_snapshot"
    | "get_active_incidents"
    | "get_sessions"
    | "get_session_messages";
  params?: Record<string, unknown>;
}

export interface DashboardQueryResult {
  queryType: string;
  data: unknown;
  cachedAt?: string;
}

export interface InstallationRecord {
  id: string;
  token: string;
  hostname: string | null;
  createdAt: string;
  online: boolean;
  lastSeen: string | null;
  manifest: CapabilityManifest | null;
}
