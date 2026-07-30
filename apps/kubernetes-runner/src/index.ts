import "dotenv/config";
import { startWebSocketClient } from "@nightwarden/runner-transport";
import { createDispatchRegistry } from "./commands/registry.js";
import { buildKubernetesManifest } from "./manifest/detect.js";
import { logger } from "./logger.js";

const token = process.env["NIGHTWARDEN_TOKEN"];
if (!token) {
  logger.fatal("NIGHTWARDEN_TOKEN is required");
  process.exit(1);
}

const wsUrl = process.env["WS_URL"];
if (!wsUrl) {
  logger.fatal("WS_URL is required");
  process.exit(1);
}

// No onHideContainer: a cluster runner enumerates workloads, and the API's own
// container is not one of them.
const stopWebSocketClient = startWebSocketClient({
  wsUrl,
  token,
  dispatch: createDispatchRegistry(),
  buildManifest: buildKubernetesManifest,
  logger,
});
logger.info("kubernetes runner started");

// The live socket and its reconnect/watchdog timers keep the event loop alive
// on Ctrl+C until tsx force-kills the process; stop() tears them all down.
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  stopWebSocketClient();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
