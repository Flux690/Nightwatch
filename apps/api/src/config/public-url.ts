import type { FastifyRequest } from "fastify";

// The address other machines reach this install on. A browser's Host header is
// not it: localhost and a proxy's hostname are unroutable from a runner.
export function publicUrl(request: FastifyRequest): string {
  const configured = process.env["PUBLIC_URL"];
  if (configured) return configured.replace(/\/+$/, "");
  return `${request.protocol}://${request.headers.host ?? "localhost"}`;
}

// ws:// for http, wss:// for https - same origin as the API.
export function publicWsUrl(request: FastifyRequest, path: string): string {
  const origin = publicUrl(request);
  return `${origin.replace(/^http/, "ws")}${path}`;
}
