import { getLokiIntegration, saveLokiIntegration } from "../db/integrations.js";
import { listMetricsSourceRows, saveMetricsSource } from "../db/metrics.js";
import { logger } from "../logger.js";
import { instantQuery } from "./metrics/client.js";
import { probeLoki } from "./loki.js";

// Empty is absent: compose writes "" for any variable the operator left unset,
// and an empty credential would be sent as a header rather than omitted.
function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

// A first-boot seed, never a live source: an integration the user has already
// connected is never overwritten. Each is probed with the exact call the console's
// Connect button makes, so a URL that cannot work fails at boot, not at 3am.
export async function seedIntegrationsFromEnv(): Promise<void> {
  await seedPrometheus();
  await seedLoki();
}

async function seedPrometheus(): Promise<void> {
  if (listMetricsSourceRows().length > 0) return;
  const url = process.env["PROMETHEUS_URL"];
  if (!url) return;
  const authHeader = optionalEnv("PROMETHEUS_AUTH_HEADER");
  const endpoint = {
    url,
    authorization: authHeader,
    orgId: null,
    name: "Prometheus",
  };

  try {
    await instantQuery(endpoint, "up");
  } catch (err) {
    logger.warn(
      { url, err },
      "PROMETHEUS_URL did not answer; leaving it unconfigured for the console",
    );
    return;
  }

  /* Seeded as its own rules endpoint, which is true of Prometheus and of
     nothing else: every other source serves rules elsewhere, and there is no
     second environment variable to guess one from. */
  saveMetricsSource({
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
  if (getLokiIntegration() !== null) return;
  const url = process.env["LOKI_URL"];
  if (!url) return;
  const authHeader = optionalEnv("LOKI_AUTH_HEADER");
  const orgId = optionalEnv("LOKI_ORG_ID");

  try {
    await probeLoki(url, authHeader, orgId);
  } catch (err) {
    logger.warn(
      { url, err },
      "LOKI_URL did not answer; leaving it unconfigured for the console",
    );
    return;
  }

  saveLokiIntegration({
    baseUrl: url,
    orgId,
    authorization: authHeader,
  });
  logger.info({ url }, "loki integration seeded from environment");
}
