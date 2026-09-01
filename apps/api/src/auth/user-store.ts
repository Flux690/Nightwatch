import { getDb } from "../db.js";

const USER_ID = "global";

export async function getUserCredentials(): Promise<{
  email: string;
  hash: string;
} | null> {
  const row = await getDb()
    .selectFrom("user")
    .select(["email", "hash"])
    .where("id", "=", USER_ID)
    .executeTakeFirst();
  if (!row?.hash || !row.email) return null;
  return { email: row.email, hash: row.hash };
}

export async function saveUser(email: string, hash: string): Promise<void> {
  const updated_at = new Date().toISOString();
  await getDb()
    .insertInto("user")
    .values({ id: USER_ID, email, hash, updated_at })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({ email, hash, updated_at }),
    )
    .execute();
}

export async function getLoginVersion(): Promise<number> {
  const row = await getDb()
    .selectFrom("user")
    .select("login_version")
    .where("id", "=", USER_ID)
    .executeTakeFirst();
  return row?.login_version ?? 0;
}

export async function bumpLoginVersion(): Promise<void> {
  const updated_at = new Date().toISOString();
  await getDb()
    .insertInto("user")
    .values({ id: USER_ID, login_version: 1, updated_at })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet((eb) => ({
        login_version: eb("user.login_version", "+", 1),
        updated_at,
      })),
    )
    .execute();
}
