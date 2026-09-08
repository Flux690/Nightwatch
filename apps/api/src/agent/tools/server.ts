import { z } from "zod";

// A fan-out wider than this is noise rather than evidence: the model cannot read
// ten servers' vitals in one turn, and the token cost is real.
export const MAX_SERVERS_PER_CALL = 8;

// Named rather than defaulted to the whole fleet: a reading that covers less
// than the model thinks it does is how an absence reads as a healthy zero.
function servers(what: string, each: string): z.ZodType<string[]> {
  return z
    .array(z.string())
    .min(1)
    .max(MAX_SERVERS_PER_CALL)
    .meta({
      description: `The ${what} to read, each written exactly as the <fleet-summary> block lists it. Name at least one and at most ${MAX_SERVERS_PER_CALL}; the result carries one labelled reading per ${each}. Call it again for any beyond that, since a call naming more than ${MAX_SERVERS_PER_CALL} is refused rather than shortened.`,
    });
}

export const dockerServers = servers("Docker hosts", "host");
export const kubernetesServers = servers("Kubernetes clusters", "cluster");
