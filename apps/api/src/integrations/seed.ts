import { getLokiIntegration, saveLokiIntegration } from "../db/integrations.js";
import { listMetricsBackendRows, saveMetricsBackend } from "../db/metrics.js";
import { encrypt } from "../secrets.js";
import { logger } from "../logger.js";
import { instantQuery } from "./metrics/client.js";
import { probeLoki } from "./loki.js";

// A first-boot seed, never a live source: an integration the user has already
// connected is never overwritten. Each is probed with the exact call the console's
// Connect button makes, so a URL that cannot work fails at boot, not at 3am.
export async function seedIntegrationsFromEnv(): Promise<void> {
  await seedPrometheus();
  await seedLoki();
}

async function seedPrometheus(): Promise<void> {
  if (listMetricsBackendRows().length > 0) return;
  const url = process.env["PROMETHEUS_URL"];
  if (!url) return;
  const authHeader = process.env["PROMETHEUS_AUTH_HEADER"] ?? null;
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
     nothing else: every other backend serves rules elsewhere, and there is no
     second environment variable to guess one from. */
  saveMetricsBackend({
    kind: "prometheus",
    label: "Prometheus",
    queryUrl: url,
    queryAuthEncrypted: authHeader ? encrypt(authHeader) : null,
    queryOrgId: null,
    rulesUrl: url,
    rulesAuthEncrypted: authHeader ? encrypt(authHeader) : null,
    rulesOrgId: null,
  });
  logger.info({ url }, "prometheus backend seeded from environment");
}

async function seedLoki(): Promise<void> {
  if (getLokiIntegration() !== null) return;
  const url = process.env["LOKI_URL"];
  if (!url) return;
  const authHeader = process.env["LOKI_AUTH_HEADER"] ?? null;
  const orgId = process.env["LOKI_ORG_ID"] ?? null;

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
    authHeaderEncrypted: authHeader ? encrypt(authHeader) : null,
  });
  logger.info({ url }, "loki integration seeded from environment");
}
