import "dotenv/config";
import { startWebSocketClient } from "@nightwarden/runner-transport";
import { createDispatchRegistry } from "./commands/registry.js";
import { buildDockerManifest } from "./manifest/detect.js";
import { hideContainer } from "./docker/client.js";
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

const stopWebSocketClient = startWebSocketClient({
  wsUrl,
  token,
  dispatch: createDispatchRegistry(),
  buildManifest: buildDockerManifest,
  logger,
  onHideContainer: hideContainer,
});
logger.info("docker runner started");

// The live socket and its reconnect/watchdog timers keep the event loop alive
// on Ctrl+C until tsx force-kills the process; stop() tears them all down.
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  stopWebSocketClient();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
