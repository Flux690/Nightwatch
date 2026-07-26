// What a failed connection attempt actually was. Read from the error's own code,
// never guessed from the URL: a hostname that resolves to loopback, a container
// name, or a private address are all legitimate and indistinguishable by shape.

// Node wraps a connection failure in a TypeError whose cause carries the code.
function failureCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown })?.cause ?? err;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

// Phrased for the operator configuring it: what went wrong, and where the attempt
// was made from, which is the part a browser cannot tell them.
export function describeNetworkFailure(err: unknown, service: string): string {
  const from = `Attempted from the NightWarden API`;
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
