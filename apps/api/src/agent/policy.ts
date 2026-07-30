import type { Platform } from "@nightwarden/shared";
import { listRunners } from "../ws/fleet.js";

// Run policy: which tools an investigation may use, derived from the connected
// fleet; pure reads, recomputed each turn.

// Every platform the fleet currently covers. Read from each runner's row rather than
// from a manifest, so it is known the moment a socket authenticates. There is no
// handshake window to special-case any more: a connected runner already knows what it is.
export function connectedPlatforms(): Set<Platform> {
  return new Set(listRunners().map((runner) => runner.platform));
}
