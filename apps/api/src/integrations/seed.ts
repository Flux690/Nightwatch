import { getLokiIntegration, saveLokiIntegration } from "./store.js";
import { saveMetricsSource } from "./metrics/store.js";
import { getMetricsSource } from "./metrics/sources.js";
import { logger } from "../logger.js";

// Empty is absent: compose writes "" for any variable the user left unset,
// and an empty credential would be sent as a header rather than omitted.
function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

// A first-boot seed that never overwrites a connected integration. Written
// without dialling out, so boot never waits on a host it does not control.
export async function seedIntegrationsFromEnv(): Promise<void> {
  await seedPrometheus();
  await seedLoki();
}

async function seedPrometheus(): Promise<void> {
  if ((await getMetricsSource()) !== null) return;
  const url = process.env["PROMETHEUS_URL"];
  if (!url) return;
  const authHeader = optionalEnv("PROMETHEUS_AUTH_HEADER");

  /* Seeded as its own rules endpoint, true of Prometheus alone: every other
     source serves rules elsewhere, and no second variable names it. */
  await saveMetricsSource({
    kind: "prometheus",
    label: "Prometheus",
    queryUrl: url,
    queryAuthorization: authHeader,
    queryOrgId: null,
    rulesUrl: url,
    rulesAuthorization: authHeader,
    rulesOrgId: null,
  });
  logger.info({ url }, "prometheus source seeded from environment");
}

async function seedLoki(): Promise<void> {
  if ((await getLokiIntegration()) !== null) return;
  const url = process.env["LOKI_URL"];
  if (!url) return;
  const authHeader = optionalEnv("LOKI_AUTH_HEADER");
  const orgId = optionalEnv("LOKI_ORG_ID");

  await saveLokiIntegration({
    baseUrl: url,
    orgId,
    authorization: authHeader,
  });
  logger.info({ url }, "loki integration seeded from environment");
}
