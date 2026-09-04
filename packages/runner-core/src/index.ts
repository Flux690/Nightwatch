export type {
  CommandHandler,
  TransportLogger,
  TransportOptions,
} from "./client.js";
export { startWebSocketClient } from "./client.js";
export { capOutput, redactSecrets, sanitize, sanitizeLines } from "./redact.js";
export { decode } from "./wire.js";
export { serverName, setServerName } from "./identity.js";
export { logger } from "./logger.js";
export { matchesFilter } from "./log-filter.js";
export { toLogLines } from "./log-lines.js";
