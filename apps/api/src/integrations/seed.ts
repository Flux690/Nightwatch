import {
  getLokiIntegration,
  getPrometheusIntegration,
  saveLokiIntegration,
  savePrometheusIntegration,
} from "../db/integrations.js";
import { encrypt } from "../secrets.js";
import { logger } from "../logger.js";
import { instantQuery } from "./prometheus.js";
import { probeLoki } from "./loki.js";

// A first-boot seed, never a live source: an integration the user has already
// connected is never overwritten. Each is probed with the exact call the console's
// Connect button makes, so a URL that cannot work fails at boot, not at 3am.
export async function seedIntegrationsFromEnv(): Promise<void> {
  await seedPrometheus();
  await seedLoki();
}

async function seedPrometheus(): Promise<void> {
  if (getPrometheusIntegration() !== null) return;
  const url = process.env["PROMETHEUS_URL"];
  if (!url) return;
  const authHeader = process.env["PROMETHEUS_AUTH_HEADER"] ?? null;

  try {
    await instantQuery(url, authHeader, "up");
  } catch (err) {
    logger.warn(
      { url, err },
      "PROMETHEUS_URL did not answer; leaving it unconfigured for the console",
    );
    return;
  }

  savePrometheusIntegration({
    baseUrl: url,
    authHeaderEncrypted: authHeader ? encrypt(authHeader) : null,
  });
  logger.info({ url }, "prometheus integration seeded from environment");
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
