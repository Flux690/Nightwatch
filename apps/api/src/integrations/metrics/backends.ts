import type {
  MetricsBackendKind,
  MetricsBackendStatus,
  MetricsEndpointInput,
  MetricsEndpointStatus,
} from "@nightwarden/shared";
import {
  getMetricsBackendRow,
  listMetricsBackendRows,
  type MetricsBackendRow,
} from "../../db/metrics.js";
import { decrypt, encrypt } from "../../secrets.js";
import { METRICS_PRESETS, type MetricsPreset } from "./presets.js";
import type { MetricsEndpoint } from "./client.js";

/* One stored row resolved into the two addresses the API dials and what this
   backend can be asked. Every caller - the tools, the verification source, the
   readiness check - asks here, so nowhere else decrypts a credential or decides
   whether a rules API exists. */
export interface MetricsBackend {
  id: string;
  kind: MetricsBackendKind;
  label: string;
  query: MetricsEndpoint;
  // Null when nothing can be asked whether the rule that fired still holds.
  rules: MetricsEndpoint | null;
  capabilities: MetricsPreset;
}

// A credential that will not decrypt reads as absent rather than crashing the
// call: a rotated SECRET_KEY should degrade to "unauthorized", not to a 500.
function plaintext(encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}

function resolve(row: MetricsBackendRow): MetricsBackend {
  const preset = METRICS_PRESETS[row.kind];
  const name = row.label || preset.label;
  return {
    id: row.id,
    kind: row.kind,
    label: name,
    query: {
      url: row.queryUrl,
      authorization: plaintext(row.queryAuthEncrypted),
      orgId: row.queryOrgId,
      name,
    },
    rules:
      row.rulesUrl === null
        ? null
        : {
            url: row.rulesUrl,
            authorization: plaintext(row.rulesAuthEncrypted),
            orgId: row.rulesOrgId,
            name: `${name} rules`,
          },
    capabilities: preset,
  };
}

export function listMetricsBackends(): MetricsBackend[] {
  return listMetricsBackendRows().map(resolve);
}

export function getMetricsBackend(id: string): MetricsBackend | null {
  const row = getMetricsBackendRow(id);
  return row === null ? null : resolve(row);
}

/* Which backend a call with no `backend` argument means. Exactly one connected
   is the ordinary install and needs no argument; with several the tools require
   one, the way a target key advertised by more than one runner does. */
export function soleMetricsBackend(): MetricsBackend | null {
  const all = listMetricsBackends();
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function hasMetricsBackend(): boolean {
  return listMetricsBackendRows().length > 0;
}

/* A basic pair becomes one Authorization value here, so the rest of the system
   holds one credential per endpoint however the user supplied it. Encoded
   rather than asked for as base64: a Grafana Cloud user is handed an instance
   id and a token, and turning those into a header is our job, not theirs. */
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

export function encryptedAuthorization(
  input: MetricsEndpointInput,
): string | null {
  const authorization = authorizationOf(input);
  return authorization === null ? null : encrypt(authorization);
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
  backend: MetricsBackend,
  validatedAt: string,
): MetricsBackendStatus {
  return {
    id: backend.id,
    kind: backend.kind,
    label: backend.label,
    query: endpointStatus(backend.query),
    rules: backend.rules === null ? null : endpointStatus(backend.rules),
    validatedAt,
  };
}
