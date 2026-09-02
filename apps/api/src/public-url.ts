import type { FastifyRequest } from "fastify";

// The address other machines reach this install on. A browser's Host header is
// not it: localhost and a proxy's hostname are unroutable from a runner.
export function publicUrl(request: FastifyRequest): string {
  return (
    configuredPublicUrl() ??
    `${request.protocol}://${request.headers.host ?? "localhost"}`
  );
}

// For a caller with no request to fall back on. Undefined in development, where
// deriving the origin from the request is correct.
export function configuredPublicUrl(): string | undefined {
  const configured = process.env["NIGHTWARDEN_PUBLIC_URL"];
  return configured ? configured.replace(/\/+$/, "") : undefined;
}

// ws:// for http, wss:// for https - same origin as the API.
export function publicWsUrl(request: FastifyRequest, path: string): string {
  const origin = publicUrl(request);
  return `${origin.replace(/^http/, "ws")}${path}`;
}
