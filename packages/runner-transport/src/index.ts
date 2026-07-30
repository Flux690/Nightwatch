export type {
  CommandHandler,
  TransportLogger,
  TransportOptions,
} from "./client.js";
export { startWebSocketClient } from "./client.js";
export { capOutput, redactSecrets, sanitize, sanitizeLines } from "./redact.js";
export {
  nested,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requiredString,
  requiredStringArray,
} from "./wire.js";
