// Two pools, because an alert storm can produce fifty runs in a minute while
// chats are self-limiting. What binds is token spend and a synchronous db.

import type { QueueState } from "@nightwarden/shared";
import { loadConfig } from "./config/store.js";
import { queueDepth } from "./session/alerts-store.js";
import { countSeats } from "./session/status-store.js";

// A backstop rather than a usage limit, which is why it is a constant and the
// investigation limit is a setting: reaching it means something is very wrong.
export const MAX_CONCURRENT_CHATS = 20;

export async function seatLimit(investigation: boolean): Promise<number> {
  return investigation
    ? (await loadConfig()).maxConcurrentInvestigations
    : MAX_CONCURRENT_CHATS;
}

// Occupancy is a count over the sessions table, never a structure of its own:
// the seat a run holds and the state that says it is running are one fact.
export async function hasSeat(investigation: boolean): Promise<boolean> {
  return (await countSeats(investigation)) < (await seatLimit(investigation));
}

// One source for the band, so the list fetch and the event cannot disagree.
export async function queueState(): Promise<QueueState> {
  const { waiting, oldestArrivedAt } = await queueDepth();
  return {
    waiting,
    running: await countSeats(true),
    limit: await seatLimit(true),
    oldestArrivedAt,
  };
}
