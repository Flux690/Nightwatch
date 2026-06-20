import "dotenv/config";
import { startWebSocketClient } from "./websocket/client.js";
import { createDispatchRegistry } from "./commands/registry.js";
import { logger } from "./logger.js";

if (!process.env["NIGHTWATCH_TOKEN"]) {
  logger.fatal("NIGHTWATCH_TOKEN is required");
  process.exit(1);
}

startWebSocketClient(createDispatchRegistry());
logger.info("runner started");
