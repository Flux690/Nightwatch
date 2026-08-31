import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { getDb, resetDb } from "../db.js";
import {
  saveMetricsSource,
  type MetricsSourceInput,
} from "../integrations/metrics/store.js";
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

// The run gate refuses without an LLM, so this is the baseline. Re-call after
// stubbing a new key: the stored one is encrypted with whichever was live.
export function configureTestLLM(): void {
  updateProvider("anthropic", { model: "test-model", apiKey: "test-api-key" });
  updateConfig({ provider: "anthropic" });
}

export function clearTestLLM(): void {
  updateConfig({ provider: null });
  getDb().prepare(`DELETE FROM provider_config`).run();
}

// One connected Prometheus, serving its own rules: the ordinary single-source
// install every seam downstream of a metrics connection assumes.
export function connectTestMetrics(
  over: Partial<MetricsSourceInput> = {},
): void {
  saveMetricsSource({
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
