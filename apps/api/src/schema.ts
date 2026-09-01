import type { Generated } from "kysely";

// The shape every query is typed against. `migrations.ts` is the frozen history
// that produced it; `Generated<T>` marks a column an insert may omit.

export interface Database {
  runner: RunnerTable;
  config: ConfigTable;
  provider_config: ProviderConfigTable;
  user: UserTable;
  integrations: IntegrationsTable;
  sessions: SessionsTable;
  alerts: AlertsTable;
  session_transcript: SessionTranscriptTable;
  schema_migrations: SchemaMigrationsTable;
}

interface RunnerTable {
  id: string;
  // The SHA-256 hash, never the credential.
  token: string;
  platform: "docker" | "kubernetes";
  server_name: string;
  created_at: string;
  last_used_at: string | null;
}

interface ConfigTable {
  id: string;
  active_provider: string | null;
  max_retries: Generated<number>;
  request_timeout_ms: Generated<number>;
  max_concurrent_investigations: Generated<number>;
  check_in_after_ms: Generated<number>;
  tool_call_ceiling_ms: Generated<number>;
  sandbox_idle_timeout_ms: Generated<number>;
  sandbox_cpus: Generated<number>;
  sandbox_memory_mb: Generated<number>;
  sandbox_require_gvisor: Generated<number>;
  sandbox_network: Generated<string>;
  // Newline-joined, which is the Settings textarea's own shape.
  sandbox_allowlist_hosts: Generated<string>;
  updated_at: string;
}

interface ProviderConfigTable {
  provider: string;
  model: string | null;
  base_url: string | null;
  api_key_encrypted: string | null;
  reasoning_level: string | null;
  max_output_tokens: number | null;
  max_input_tokens: number | null;
  compaction: Generated<number>;
  reasoning: string | null;
  updated_at: string;
}

interface UserTable {
  id: string;
  email: string | null;
  hash: string | null;
  login_version: Generated<number>;
  updated_at: string;
}

interface IntegrationsTable {
  id: string;
  kind: string;
  name: string;
  config: string;
  // One encrypted value whose plaintext is a map, so a row can carry two.
  secrets: string | null;
  // Set only for a sender that presents a credential to us.
  token_hash: string | null;
  validated_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface SessionsTable {
  session_id: string;
  title: Generated<string>;
  investigation: Generated<number>;
  // Every value but 'running' derives from the columns below; 'running' is
  // claimed by a conditional UPDATE, so the row is the dispatch mutex too.
  status: Generated<
    | "action_required"
    | "running"
    | "resolved"
    | "stopped"
    | "failed"
    | "completed"
  >;
  failed_attempts: Generated<number>;
  failure_kind: "transient" | "permanent" | null;
  stopped_at: string | null;
  // The gate, all null when the session is not parked on one.
  awaiting_tool_use_id: string | null;
  awaiting_kind: "approval" | "clarification" | "continue" | null;
  awaiting_results: Generated<string>;
  // Stamped before an approved call runs, so a crash in the gap says the write
  // may already have happened rather than replaying it.
  attempt_started_at: string | null;
  hypotheses: Generated<string>;
  report: string | null;
  record_updated_at: string | null;
  created_at: string;
  last_activity_at: string;
}

interface AlertsTable {
  id: Generated<number>;
  session_id: string | null;
  group_key: string;
  source_alert_id: string;
  // Its own column so json_each reads the labels without the alert beside them.
  labels: Generated<string>;
  alert_type: Generated<string>;
  fired_at: string;
  arrived_at: string;
  cleared_at: string | null;
  injected: Generated<number>;
  dropped_alerts: Generated<number>;
  group_context: string | null;
  alert: string;
}

interface SessionTranscriptTable {
  session_id: string;
  seq: number;
  kind: string;
  content: string;
  canonical: string | null;
  timestamp: string;
}

interface SchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: string;
}
