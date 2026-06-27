import { mintSession } from "../auth/session.js";

// Returns a valid nw_auth cookie for the given loginVersion (default 0, matching a fresh
// temp DB). Usage: headers: { cookie: `nw_auth=${await mintTestSession()}` }.
export async function mintTestSession(loginVersion = 0): Promise<string> {
  return mintSession(loginVersion);
}
