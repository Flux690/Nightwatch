import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { getDb, resetDb } from "../db/client.js";
import { saveMetricsBackend, type MetricsBackendInput } from "../db/metrics.js";
import { updateConfig, updateProvider } from "../config/store.js";

// Call at the top of beforeAll before anything opens the lazy db; pair the
// teardown with vi.unstubAllEnvs().
export function useTempDb(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "nw-api-"));
  vi.stubEnv("NIGHTWARDEN_DIR", dir);
  configureTestLLM();
  return () => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  };
}

// The run gate refuses without an LLM, so an installed system is the baseline for
// every seam downstream of it. Re-call after stubbing a different SECRET_KEY: the
// stored key is encrypted with whichever one was live when it was written.
export function configureTestLLM(): void {
  updateProvider("anthropic", { model: "test-model", apiKey: "test-api-key" });
  updateConfig({ provider: "anthropic" });
}

export function clearTestLLM(): void {
  updateConfig({ provider: null });
  getDb().prepare(`DELETE FROM provider_config`).run();
}

// One connected Prometheus, serving its own rules: the ordinary single-backend
// install every seam downstream of a metrics connection assumes.
export function connectTestMetrics(
  over: Partial<MetricsBackendInput> = {},
): string {
  return saveMetricsBackend({
    kind: "prometheus",
    label: "Prometheus",
    queryUrl: "http://prom.internal:9090",
    queryAuthorization: null,
    queryOrgId: null,
    rulesUrl: "http://prom.internal:9090",
    rulesAuthorization: null,
    rulesOrgId: null,
    ...over,
  });
}
