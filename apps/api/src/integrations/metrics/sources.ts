import type {
  AmpCredential,
  MetricsSourceKind,
  MetricsSourceStatus,
  MetricsEndpointInput,
  MetricsEndpointStatus,
} from "@nightwarden/shared";
import { metricsSourceRow, type MetricsSourceRow } from "./store.js";
import { METRICS_PRESETS, type MetricsPreset } from "./presets.js";
import type { MetricsEndpoint } from "./client.js";

/* One stored row resolved into the addresses the API dials. Every caller asks
   here, so nowhere else decrypts a credential or decides whether a rules API
   exists. */
export interface MetricsSource {
  kind: MetricsSourceKind;
  label: string;
  query: MetricsEndpoint;
  // Null when nothing can be asked whether the rule that fired still holds.
  rules: MetricsEndpoint | null;
  capabilities: MetricsPreset;
}

// AMP has no static header, so its "authorization" secret slot stores the
// credential JSON-encoded instead.
function decodeAmpCredential(raw: string | null): AmpCredential | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AmpCredential>;
    if (
      typeof parsed.accessKeyId !== "string" ||
      typeof parsed.secretAccessKey !== "string" ||
      typeof parsed.region !== "string"
    ) {
      return undefined;
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      region: parsed.region,
      ...(typeof parsed.sessionToken === "string" && {
        sessionToken: parsed.sessionToken,
      }),
    };
  } catch {
    return undefined;
  }
}

function ampEndpoint(
  url: string,
  authorization: string | null,
  orgId: string | null,
  name: string,
): MetricsEndpoint {
  const sigv4 = decodeAmpCredential(authorization);
  return { url, authorization: null, orgId, name, ...(sigv4 && { sigv4 }) };
}

function resolve(row: MetricsSourceRow): MetricsSource {
  const preset = METRICS_PRESETS[row.kind];
  const name = row.label || preset.label;
  const query =
    row.kind === "amp"
      ? ampEndpoint(row.queryUrl, row.queryAuthorization, row.queryOrgId, name)
      : {
          url: row.queryUrl,
          authorization: row.queryAuthorization,
          orgId: row.queryOrgId,
          name,
        };
  const rules =
    row.rulesUrl === null
      ? null
      : row.kind === "amp"
        ? ampEndpoint(
            row.rulesUrl,
            row.rulesAuthorization,
            row.rulesOrgId,
            `${name} rules`,
          )
        : {
            url: row.rulesUrl,
            authorization: row.rulesAuthorization,
            orgId: row.rulesOrgId,
            name: `${name} rules`,
          };
  return {
    kind: row.kind,
    label: name,
    query,
    rules,
    capabilities: preset,
  };
}

// One connected source or none, so nothing addresses it and no call names it.
export function getMetricsSource(): MetricsSource | null {
  const row = metricsSourceRow();
  return row === null ? null : resolve(row);
}

// Encoded here rather than asked for as base64: a Grafana Cloud user is handed
// an instance id and a token, and turning those into a header is our job.
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

export function ampCredentialOf(
  input: MetricsEndpointInput,
): AmpCredential | null {
  if (
    input.accessKeyId === undefined ||
    input.secretAccessKey === undefined ||
    input.region === undefined
  ) {
    return null;
  }
  return {
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    region: input.region,
    ...(input.sessionToken !== undefined && {
      sessionToken: input.sessionToken,
    }),
  };
}

// The opaque per-endpoint secret slot: a header for every other kind, the AMP
// credential JSON-encoded for amp.
export function secretFor(
  input: MetricsEndpointInput,
  kind: MetricsSourceKind,
): string | null {
  if (kind !== "amp") return authorizationOf(input);
  const credential = ampCredentialOf(input);
  return credential === null ? null : JSON.stringify(credential);
}

// The endpoint the API will dial for a configuration nobody has saved yet,
// which is what a connect probe tests before anything is written.
export function endpointFrom(
  input: MetricsEndpointInput,
  name: string,
  kind: MetricsSourceKind,
): MetricsEndpoint {
  if (kind === "amp") {
    const credential = ampCredentialOf(input);
    return {
      url: input.url,
      authorization: null,
      orgId: input.orgId ?? null,
      name,
      ...(credential !== null && { sigv4: credential }),
    };
  }
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
    hasAuth: endpoint.authorization !== null || endpoint.sigv4 !== undefined,
    hasOrgId: endpoint.orgId !== null,
  };
}

// Loki's shape: an unconfigured answer is a filled-in "no" rather than a null
// the caller has to guard.
export function statusOf(
  source: MetricsSource | null,
  validatedAt: string | null,
): MetricsSourceStatus {
  if (source === null) {
    return {
      configured: false,
      kind: null,
      label: null,
      query: null,
      rules: null,
      validatedAt: null,
    };
  }
  return {
    configured: true,
    kind: source.kind,
    label: source.label,
    query: endpointStatus(source.query),
    rules: source.rules === null ? null : endpointStatus(source.rules),
    validatedAt,
  };
}
