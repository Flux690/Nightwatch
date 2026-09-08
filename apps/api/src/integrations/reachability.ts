/* What a call made outside a run may take: a person clicking Connect is waiting
   on it, and boot and the recovery sweep must not stall on a silent host. */
export const PROBE_TIMEOUT_MS = 10_000;

export function probeSignal(): AbortSignal {
  return AbortSignal.timeout(PROBE_TIMEOUT_MS);
}

// Read from the error's own code, never guessed from the URL: loopback, a
// container name and a private address are all legitimate and alike by shape.
function failureCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown })?.cause ?? err;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

// Phrased for the user configuring it: what went wrong, and where the attempt
// was made from, which is the part a browser cannot tell them.
export function describeNetworkFailure(err: unknown, service: string): string {
  const from = `Attempted from the NightWarden API`;
  // An abort carries the caller's own limit rather than the network's verdict.
  if ((err as { name?: unknown })?.name === "TimeoutError") {
    return `${service} did not answer within the time this call was given. ${from}.`;
  }
  switch (failureCode(err)) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not resolve that hostname. ${from}, which resolves names on its own network. ${service} may be reachable from your machine and not from there.`;
    case "ECONNREFUSED":
      return `Reached the host, but nothing is listening on that port. ${from}.`;
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `No response before the timeout, which usually means a firewall or an unroutable address. ${from}.`;
    case "ECONNRESET":
      return `The connection was closed mid-request. ${from}.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `The TLS certificate is self-signed and not trusted. ${from}.`;
    case "CERT_HAS_EXPIRED":
      return `The TLS certificate has expired. ${from}.`;
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `The TLS certificate could not be verified. ${from}.`;
    default:
      return `Could not reach ${service}. ${from}.`;
  }
}
