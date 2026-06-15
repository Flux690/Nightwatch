import { mintSession } from "../auth/session.js";

// Returns a valid nw_auth cookie value for the given loginVersion (default 0).
// Usage:
//   headers: { cookie: `nw_auth=${await mintTestSession()}` }
// loginVersion defaults to 0, which matches a fresh temp DB (login_version default).
export async function mintTestSession(loginVersion = 0): Promise<string> {
  return mintSession(loginVersion);
}
