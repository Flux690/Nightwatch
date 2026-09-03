import { randomUUID } from "node:crypto";
import { isPlatform, type Platform } from "@nightwarden/shared";
import { getDb } from "../db.js";
import { hashToken, issueToken, tokenMatches } from "../secrets.js";

// Runner record stored in DB: the SHA-256 hash (hex) of the plaintext nwr_... credential.
// Plaintext is returned once at generation and never stored or logged.
type RunnerRow = {
  id: string;
  tokenHash: string;
  platform: Platform;
  serverName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

// Public view returned by the list endpoint: no hash, no plaintext.
type RunnerMeta = {
  id: string;
  platform: Platform;
  serverName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

// The plaintext is returned once and only its hash stored. Neither platform nor
// serverName defaults: a runner not knowing what or where it is is the bug.
export async function generateRunnerToken(
  platform: Platform,
  serverName: string,
): Promise<{ plaintext: string } & RunnerMeta> {
  const plaintext = issueToken("nwr");
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  await getDb()
    .transaction()
    .execute(async (trx) => {
      // A row with this server_name that never connected is an orphan from an
      // aborted setup - free it. A connected row is real, left for the UNIQUE 409.
      await trx
        .deleteFrom("runner")
        .where("server_name", "=", serverName)
        .where("last_used_at", "is", null)
        .execute();
      await trx
        .insertInto("runner")
        .values({
          id,
          token: hashToken(plaintext),
          platform,
          server_name: serverName,
          created_at: createdAt,
        })
        .execute();
    });

  return {
    plaintext,
    id,
    platform,
    serverName,
    createdAt,
    lastUsedAt: null,
  };
}

const SELECT_ROW = [
  "id",
  "token as tokenHash",
  "platform",
  "server_name as serverName",
  "created_at as createdAt",
  "last_used_at as lastUsedAt",
] as const;

function text(raw: Record<string, unknown>, column: string): string {
  const value = raw[column];
  if (typeof value !== "string") {
    throw new Error(`runner.${column} is missing or not text`);
  }
  return value;
}

function nullableText(
  raw: Record<string, unknown>,
  column: string,
): string | null {
  const value = raw[column];
  return typeof value === "string" ? value : null;
}

function mapRow(raw: Record<string, unknown>): RunnerRow {
  const platform = raw["platform"];
  // The CHECK constraint already refuses anything else, so this can only fire on
  // a database edited by hand. Failing beats silently onboarding an unroutable runner.
  if (!isPlatform(platform)) {
    throw new Error(`runner.platform holds an unrecognised value`);
  }
  return {
    id: text(raw, "id"),
    tokenHash: text(raw, "tokenHash"),
    platform,
    serverName: text(raw, "serverName"),
    createdAt: text(raw, "createdAt"),
    lastUsedAt: nullableText(raw, "lastUsedAt"),
  };
}

export async function findRunnerByToken(
  plaintext: string,
): Promise<RunnerRow | undefined> {
  /* Scanned and compared in constant time rather than looked up on the token
     index, which is the same rule the ingest credential follows. */
  for (const raw of await getDb()
    .selectFrom("runner")
    .select(SELECT_ROW)
    .execute()) {
    if (tokenMatches(plaintext, raw.tokenHash)) return mapRow(raw);
  }
  return undefined;
}

// Touch last_used_at on every authenticated use (WS connect, ingest, chat).
export async function touchLastUsed(id: string): Promise<void> {
  await getDb()
    .updateTable("runner")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute();
}

export async function deleteRunner(id: string): Promise<boolean> {
  const res = await getDb()
    .deleteFrom("runner")
    .where("id", "=", id)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

// Public list: no hash, no plaintext, newest first.
export async function listRunnersMeta(): Promise<RunnerMeta[]> {
  const rows = await getDb()
    .selectFrom("runner")
    .select(SELECT_ROW)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => {
    const { tokenHash: _tokenHash, ...meta } = mapRow(r);
    return meta;
  });
}
