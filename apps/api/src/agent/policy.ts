import type { Platform } from "@nightwarden/shared";
import { listRunners } from "../fleet/connections.js";

// Read from each runner's row rather than a manifest, so it is known the moment
// a socket authenticates and no handshake window needs special-casing.
export function connectedPlatforms(): Set<Platform> {
  return new Set(listRunners().map((runner) => runner.platform));
}
