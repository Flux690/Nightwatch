import type {
  MetricsSourceKind,
  MetricsSourceStatus,
  MetricsEndpointInput,
  MetricsEndpointStatus,
} from "@nightwarden/shared";
import {
  getMetricsSourceRow,
  listMetricsSourceRows,
  type MetricsSourceRow,
} from "../../db/metrics.js";
import { METRICS_PRESETS, type MetricsPreset } from "./presets.js";
import type { MetricsEndpoint } from "./client.js";

/* One stored row resolved into the addresses the API dials. Every caller asks
   here, so nowhere else decrypts a credential or decides whether a rules API
   exists. */
export interface MetricsSource {
  id: string;
  kind: MetricsSourceKind;
  label: string;
  query: MetricsEndpoint;
  // Null when nothing can be asked whether the rule that fired still holds.
  rules: MetricsEndpoint | null;
  capabilities: MetricsPreset;
}

function resolve(row: MetricsSourceRow): MetricsSource {
  const preset = METRICS_PRESETS[row.kind];
  const name = row.label || preset.label;
  return {
    id: row.id,
    kind: row.kind,
    label: name,
    query: {
      url: row.queryUrl,
      authorization: row.queryAuthorization,
      orgId: row.queryOrgId,
      name,
    },
    rules:
      row.rulesUrl === null
        ? null
        : {
            url: row.rulesUrl,
            authorization: row.rulesAuthorization,
            orgId: row.rulesOrgId,
            name: `${name} rules`,
          },
    capabilities: preset,
  };
}

export function listMetricsSources(): MetricsSource[] {
  return listMetricsSourceRows().map(resolve);
}

export function getMetricsSource(id: string): MetricsSource | null {
  const row = getMetricsSourceRow(id);
  return row === null ? null : resolve(row);
}

/* Which source a call with no `source` argument means. Exactly one connected
   is the ordinary install and needs no argument; with several the tools require
   one, the way a target key advertised by more than one runner does. */
export function soleMetricsSource(): MetricsSource | null {
  const all = listMetricsSources();
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function hasMetricsSource(): boolean {
  return listMetricsSourceRows().length > 0;
}

/* A basic pair becomes one Authorization value here. Encoded rather than asked
   for as base64: a Grafana Cloud user is handed an instance id and a token, and
   turning those into a header is our job. */
export function authorizationOf(input: MetricsEndpointInput): string | null {
  if (input.authHeader !== undefined && input.authHeader !== "") {
    return input.authHeader;
  }
  if (input.basicUsername === undefined || input.basicPassword === undefined) {
    return null;
  }
  const pair = `${input.basicUsername}:${input.basicPassword}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

// The endpoint the API will dial for a configuration nobody has saved yet,
// which is what a connect probe tests before anything is written.
export function endpointFrom(
  input: MetricsEndpointInput,
  name: string,
): MetricsEndpoint {
  return {
    url: input.url,
    authorization: authorizationOf(input),
    orgId: input.orgId ?? null,
    name,
  };
}

function endpointStatus(endpoint: MetricsEndpoint): MetricsEndpointStatus {
  return {
    url: endpoint.url,
    hasAuth: endpoint.authorization !== null,
    hasOrgId: endpoint.orgId !== null,
  };
}

export function statusOf(
  source: MetricsSource,
  validatedAt: string,
): MetricsSourceStatus {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    query: endpointStatus(source.query),
    rules: source.rules === null ? null : endpointStatus(source.rules),
    validatedAt,
  };
}
