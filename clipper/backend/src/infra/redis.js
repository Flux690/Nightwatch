import Redis from "ioredis";
import { log } from "../utils/log.js";

let client = null;

function getClient() {
  if (!client) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL environment variable is not set");
    }
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        // Reconnect after 1 second, up to 10 attempts
        if (times > 10) return null;
        return 1000;
      },
      lazyConnect: true
    });
  }
  return client;
}

export async function queueJob(queueName, data) {
  try {
    await getClient().lpush(queueName, JSON.stringify(data));
  } catch (err) {
    log("error", {
      error_code: "REDIS_QUEUE_FAILED",
      message: err.message,
      queue: queueName
    });
    throw err;
  }
}

export async function dequeueJob(queueName, timeout = 5) {
  try {
    const result = await getClient().brpop(queueName, timeout);
    if (result) {
      return JSON.parse(result[1]);
    }
    return null;
  } catch (err) {
    log("error", {
      error_code: "REDIS_DEQUEUE_FAILED",
      message: err.message,
      queue: queueName
    });
    throw err;
  }
}

// Log once on first failure, then silent until recovery
let connectionErrorLogged = false;

export async function dequeueJobSilent(queueName, timeout = 5) {
  try {
    const result = await getClient().brpop(queueName, timeout);
    if (result) {
      if (connectionErrorLogged) {
        log("info", { event: "REDIS_CONNECTION_RESTORED", queue: queueName });
        connectionErrorLogged = false;
      }
      return JSON.parse(result[1]);
    }
    // brpop returned null (timeout) — connection is fine
    if (connectionErrorLogged) {
      connectionErrorLogged = false;
    }
    return null;
  } catch (err) {
    if (!connectionErrorLogged) {
      log("error", {
        error_code: "REDIS_CONNECTION_LOST",
        message: err.message,
        queue: queueName
      });
      connectionErrorLogged = true;
    }
    return null;
  }
}

export async function publishEvent(channel, data) {
  try {
    await getClient().publish(channel, JSON.stringify(data));
  } catch (err) {
    log("error", {
      error_code: "REDIS_PUBLISH_FAILED",
      message: err.message,
      channel
    });
    throw err;
  }
}

export function getRedisClient() {
  return getClient();
}
