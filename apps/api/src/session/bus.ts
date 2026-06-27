import { EventEmitter } from "node:events";

// Live console events ride an in-process event bus, not Redis (D2): one Node process serves
// the console, so cross-process fan-out solves a problem we don't have. The console WS
// forwards every envelope and the client routes by type/sessionId.
const CONSOLE_EVENT = "console-event";

// One listener per open console socket; a single-admin deployment has very few.
// 0 disables Node's leak warning rather than capping at an arbitrary number.
const consoleBus = new EventEmitter();
consoleBus.setMaxListeners(0);

// The serialized envelope is published as-is. Delivery is best-effort and
// ephemeral - the durable record is the SessionMessage persisted locally when
// the turn completes, so a publish must never throw into the investigation loop.
export function publishConsoleEvent(serializedEnvelope: string): void {
  consoleBus.emit(CONSOLE_EVENT, serializedEnvelope);
}

export function subscribeConsole(
  listener: (envelope: string) => void,
): () => void {
  consoleBus.on(CONSOLE_EVENT, listener);
  return () => consoleBus.off(CONSOLE_EVENT, listener);
}
