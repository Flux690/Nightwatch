import { db } from "../db/client.js";

const ADMIN_EMAIL =
  process.env["NIGHTWATCH_ADMIN_EMAIL"] ?? "admin@nightwatch.local";

// Single-admin model (D5): one owner for the whole deployment. Installations
// hang off this user. The real login wall lands in Phase 7; for now we ensure
// the singleton exists so token generation has an owner.
export async function ensureAdminUser(): Promise<{ id: string }> {
  const existing = await db.user.findFirst();
  if (existing) return existing;
  return db.user.create({ data: { email: ADMIN_EMAIL, name: "Admin" } });
}
