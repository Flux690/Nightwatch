import { EventEmitter } from "node:events";

// Live console events ride an in-process event bus, not Redis pub/sub (CONTEXT.md
// D2): one Node process serves the console, so cross-process fan-out solves a
// problem we do not have. Every published envelope is emitted on one channel and
// the console WS handler forwards all of them to its socket - the client routes
// by type and sessionId, exactly as it did when it pattern-subscribed to every
// Redis channel.
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
