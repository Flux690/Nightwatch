import { mintSession } from "../auth/session.js";

// Returns a valid nw_session cookie value for the given epoch (default 0).
// The returned string can be used directly as a Cookie header value:
//   headers: { cookie: `nw_session=${mintTestSession()}` }
// Epoch defaults to 0 which matches a fresh temp DB (session_epoch default).
export function mintTestSession(epoch = 0): string {
  return mintSession(epoch);
}
