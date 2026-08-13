import { loadConfig } from "./config/store.js";
import { countSeats } from "./db/sessions.js";

/* How many runs may be in flight at once. Two pools, because what starts them
   differs: an alert storm is machine-generated and can produce fifty runs in a
   minute, while chats are human-initiated and self-limiting. Neither can take
   the other's seat.

   What binds is token spend per concurrent run and better-sqlite3 being
   synchronous, so every persist() blocks the loop for everyone. Both scale with
   concurrent runs whatever started them. */

// A backstop rather than a usage limit, which is why it is a constant and the
// investigation limit is a setting: reaching it means something is very wrong.
export const MAX_CONCURRENT_CHATS = 20;

export function seatLimit(investigation: boolean): number {
  return investigation
    ? loadConfig().maxConcurrentInvestigations
    : MAX_CONCURRENT_CHATS;
}

// Occupancy is a count over the sessions table, never a structure of its own:
// the seat a run holds and the state that says it is running are one fact.
export function hasSeat(investigation: boolean): boolean {
  return countSeats(investigation) < seatLimit(investigation);
}
