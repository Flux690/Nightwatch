import { z } from "zod";
import { logger } from "../logger.js";
import { CATALOG_TIMEOUT_MS } from "./config.js";

/* What no provider's own endpoint publishes: which reasoning levels a model
   takes, what its two limits are, and whether it can call a tool at all. */
const SNAPSHOT_URL = "https://models.dev/api.json";

// Long enough that a settings page costs nothing, short enough that a model
// released today is described within a day.
const TTL_MS = 24 * 60 * 60_000;

// A cold failure is cached too, so an install with no route out does not refetch
// on every settings load.
const NEGATIVE_TTL_MS = 5 * 60_000;

/* Only what is read. models.dev publishes far more per model, and a field this
   does not name cannot break the parse when it changes shape. */
const ModelSchema = z.object({
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(
      z.object({ type: z.string(), values: z.array(z.string()).optional() }),
    )
    .optional(),
  tool_call: z.boolean().optional(),
  limit: z
    .object({ context: z.number().optional(), output: z.number().optional() })
    .optional(),
});

/* One model at a time, because this is 200 vendors in one document: an entry
   nobody here reads must not cost every other vendor its capabilities. */
const SnapshotSchema = z.record(
  z.string(),
  z
    .object({ models: z.record(z.string(), ModelSchema.catch({})) })
    .catch({ models: {} }),
);

export type ModelCapabilities = z.infer<typeof ModelSchema>;
type Snapshot = z.infer<typeof SnapshotSchema>;

let held: { snapshot: Snapshot | null; until: number } | null = null;
let inFlight: Promise<Snapshot | null> | null = null;

async function download(): Promise<Snapshot | null> {
  try {
    const res = await fetch(SNAPSHOT_URL, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return SnapshotSchema.parse(await res.json());
  } catch (err) {
    logger.warn({ err }, "could not read the model capability snapshot");
    return null;
  }
}

/* Serving the last good copy past its expiry is the point: capabilities change
   slowly, and a catalogue with no reasoning ladder is worse than a stale one. */
async function snapshot(): Promise<Snapshot | null> {
  if (held !== null && Date.now() < held.until) return held.snapshot;
  inFlight ??= download().finally(() => {
    inFlight = null;
  });
  const fresh = await inFlight;
  if (fresh === null && held?.snapshot != null) {
    held = { snapshot: held.snapshot, until: Date.now() + NEGATIVE_TTL_MS };
    return held.snapshot;
  }
  held = {
    snapshot: fresh,
    until: Date.now() + (fresh === null ? NEGATIVE_TTL_MS : TTL_MS),
  };
  return fresh;
}

/* Keyed by provider and then by the id that provider itself lists, which match
   on both sides with no mapping. Undefined for an id the snapshot has not met. */
export async function capabilitiesFor(
  provider: string,
): Promise<ReadonlyMap<string, ModelCapabilities>> {
  const models = (await snapshot())?.[provider]?.models;
  return new Map(Object.entries(models ?? {}));
}

// Test seam: the snapshot is process-wide, so a case that stubs fetch has to be
// able to clear what an earlier one left behind.
export function forgetCapabilities(): void {
  held = null;
  inFlight = null;
}
