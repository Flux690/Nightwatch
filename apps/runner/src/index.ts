import "dotenv/config";
import { startWebSocketClient } from "./websocket/client.js";
import { createDispatchRegistry } from "./commands/registry.js";
import { logger } from "./logger.js";

if (!process.env["NIGHTWATCH_TOKEN"]) {
  logger.fatal("NIGHTWATCH_TOKEN is required");
  process.exit(1);
}

const stopWebSocketClient = startWebSocketClient(createDispatchRegistry());
logger.info("runner started");

// The live socket and its reconnect/watchdog timers keep the event loop alive
// on Ctrl+C until tsx force-kills the process; stop() tears them all down.
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  stopWebSocketClient();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
