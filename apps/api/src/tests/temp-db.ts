import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { getDb, resetDb } from "../db.js";
import { resetAuth } from "../auth/instance.js";
import {
  saveMetricsSource,
  type MetricsSourceInput,
} from "../integrations/metrics/store.js";
import { updateConfig, updateProvider } from "../config/store.js";
import { seedCatalog } from "../llm/catalog.js";

// Call at the top of beforeAll before anything opens the lazy db; pair the
// teardown with vi.unstubAllEnvs().
export async function useTempDb(): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "nw-api-"));
  vi.stubEnv("NIGHTWARDEN_DIR", dir);
  await configureTestLLM();
  return () => {
    // The auth instance holds the handle resetDb closes, so it goes with it.
    resetAuth();
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  };
}

// The run gate refuses without an LLM, so this is the baseline. Re-call after
// stubbing a new key: the stored one is encrypted with whichever was live.
export async function configureTestLLM(): Promise<void> {
  await updateProvider("anthropic", {
    model: "test-model",
    apiKey: "test-api-key",
  });
  await updateConfig({ provider: "anthropic" });
  // A run resolves its model from the catalogue, which is seeded rather than
  // fetched so no test reaches a provider to start one.
  seedCatalog("anthropic", [
    {
      id: "test-model",
      reasoning: null,
      maxInputTokens: 200_000,
      maxOutputTokens: 32_000,
      compaction: false,
    },
  ]);
}

export async function clearTestLLM(): Promise<void> {
  await updateConfig({ provider: null });
  await getDb().deleteFrom("provider_config").execute();
}

// One connected Prometheus, serving its own rules: the ordinary single-source
// install every seam downstream of a metrics connection assumes.
export async function connectTestMetrics(
  over: Partial<MetricsSourceInput> = {},
): Promise<void> {
  await saveMetricsSource({
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
