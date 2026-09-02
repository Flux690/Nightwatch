import type { MetricsSourceKind } from "@nightwarden/shared";
import {
  allIntegrations,
  deleteIntegrationById,
  putIntegration,
  type IntegrationRow,
} from "../store.js";
import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";

/* A metrics source is a connection like any other; only its config shape is
   its own. Two endpoints and two credentials fit because `secrets` is a map. */

export interface MetricsSourceRow {
  id: string;
  kind: MetricsSourceKind;
  label: string;
  queryUrl: string;
  queryAuthorization: string | null;
  queryOrgId: string | null;
  rulesUrl: string | null;
  rulesAuthorization: string | null;
  rulesOrgId: string | null;
  validatedAt: string;
  createdAt: string;
}

interface Endpoint {
  url: string;
  orgId: string | null;
}

interface MetricsConfig {
  query: Endpoint;
  rules: Endpoint | null;
}

function toSource(row: IntegrationRow): MetricsSourceRow {
  const config = row.config as unknown as MetricsConfig;
  return {
    id: row.id,
    kind: row.kind as MetricsSourceKind,
    label: row.name,
    queryUrl: config.query.url,
    queryAuthorization: row.secrets["query"] ?? null,
    queryOrgId: config.query.orgId,
    rulesUrl: config.rules?.url ?? null,
    rulesAuthorization: row.secrets["rules"] ?? null,
    rulesOrgId: config.rules?.orgId ?? null,
    validatedAt: row.validatedAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

function isMetricsRow(row: IntegrationRow): boolean {
  return (METRICS_SOURCE_KINDS as readonly string[]).includes(row.kind);
}

/* One source whatever the product, so this filters the set of five kinds rather
   than reading one fixed kind. The connect route refuses a second. */
export async function metricsSourceRow(): Promise<MetricsSourceRow | null> {
  const row = (await allIntegrations()).find(isMetricsRow);
  return row === undefined ? null : toSource(row);
}

export interface MetricsSourceInput {
  kind: MetricsSourceKind;
  label: string;
  queryUrl: string;
  queryAuthorization: string | null;
  queryOrgId: string | null;
  rulesUrl: string | null;
  rulesAuthorization: string | null;
  rulesOrgId: string | null;
}

export async function saveMetricsSource(
  input: MetricsSourceInput,
): Promise<void> {
  const secrets: Record<string, string> = {};
  if (input.queryAuthorization !== null) {
    secrets["query"] = input.queryAuthorization;
  }
  if (input.rulesAuthorization !== null) {
    secrets["rules"] = input.rulesAuthorization;
  }
  await putIntegration(
    {
      kind: input.kind,
      name: input.label,
      config: {
        query: { url: input.queryUrl, orgId: input.queryOrgId },
        rules:
          input.rulesUrl === null
            ? null
            : { url: input.rulesUrl, orgId: input.rulesOrgId },
      } satisfies MetricsConfig,
      secrets,
    },
    // Reconnecting replaces in place, as Loki does, so the row keeps its id.
    (await metricsSourceRow())?.id,
  );
}

export async function deleteMetricsSource(): Promise<void> {
  const row = await metricsSourceRow();
  if (row !== null) await deleteIntegrationById(row.id);
}
