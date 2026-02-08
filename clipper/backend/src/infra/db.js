import pg from "pg";
import { log } from "../utils/log.js";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function query(text, params) {
  try {
    const result = await getPool().query(text, params);
    return result;
  } catch (err) {
    log("error", {
      error_code: "DATABASE_QUERY_FAILED",
      message: err.message,
      query: text
    });
    throw err;
  }
}

export async function getClient() {
  try {
    return await getPool().connect();
  } catch (err) {
    log("error", {
      error_code: "DATABASE_CONNECTION_FAILED",
      message: err.message
    });
    throw err;
  }
}
