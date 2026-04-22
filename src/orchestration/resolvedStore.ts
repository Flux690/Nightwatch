/**
 * In-memory store for recently resolved incidents.
 * Used by the analyzer to skip re-processing known-resolved incidents.
 */

import type { ResolvedIncident } from "../types";

const RESOLVED_TTL_MS = 300_000; // 5 minutes
const MAX_ENTRIES = 20;

const resolvedIncidents: ResolvedIncident[] = [];

function pruneResolved(): void {
  const cutoff = Date.now() - RESOLVED_TTL_MS;
  let i = 0;
  while (i < resolvedIncidents.length) {
    if (resolvedIncidents[i].resolvedAt < cutoff) {
      resolvedIncidents.splice(i, 1);
    } else {
      i++;
    }
  }
  // Cap at MAX_ENTRIES (oldest first)
  while (resolvedIncidents.length > MAX_ENTRIES) {
    resolvedIncidents.shift();
  }
}

export function addResolved(entry: ResolvedIncident): void {
  resolvedIncidents.push(entry);
  pruneResolved();
}

export function getResolvedIncidents(): ResolvedIncident[] {
  pruneResolved();
  return [...resolvedIncidents];
}
