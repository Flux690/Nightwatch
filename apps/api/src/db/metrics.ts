import type { MetricsSourceKind } from "@nightwarden/shared";
import {
  allIntegrations,
  deleteIntegrationById,
  integrationById,
  integrationsOfKind,
  putIntegration,
  type IntegrationRow,
} from "./integrations.js";
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

export function listMetricsSourceRows(): MetricsSourceRow[] {
  return allIntegrations().filter(isMetricsRow).map(toSource);
}

export function getMetricsSourceRow(id: string): MetricsSourceRow | null {
  const row = integrationById(id);
  return row === null || !isMetricsRow(row) ? null : toSource(row);
}

export function countMetricsSourcesOfKind(kind: MetricsSourceKind): number {
  return integrationsOfKind(kind).length;
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

export function saveMetricsSource(
  input: MetricsSourceInput,
  id?: string,
): string {
  const secrets: Record<string, string> = {};
  if (input.queryAuthorization !== null) {
    secrets["query"] = input.queryAuthorization;
  }
  if (input.rulesAuthorization !== null) {
    secrets["rules"] = input.rulesAuthorization;
  }
  return putIntegration(
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
    id,
  );
}

export function deleteMetricsSource(id: string): boolean {
  const row = integrationById(id);
  if (row === null || !isMetricsRow(row)) return false;
  return deleteIntegrationById(id);
}
