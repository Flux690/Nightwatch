import { EventEmitter } from "node:events";
import type { ConsoleEvent } from "@nightwatch/shared";

// Live console events ride an in-process event bus, not Redis: one Node process serves
// the console, so cross-process fan-out solves a problem we don't have. The SSE route
// forwards every event and the client routes by type/sessionId.
const CONSOLE_EVENT = "console-event";

// One listener per open console event stream; a single-admin deployment has very few.
// 0 disables Node's leak warning rather than capping at an arbitrary number.
const consoleBus = new EventEmitter();
consoleBus.setMaxListeners(0);

// Delivery is best-effort and ephemeral - the durable record is the SessionMessage
// persisted locally when the turn completes, so a publish must never throw into the
// investigation loop.
export function publishConsoleEvent(event: ConsoleEvent): void {
  consoleBus.emit(CONSOLE_EVENT, event);
}

export function subscribeConsole(
  listener: (event: ConsoleEvent) => void,
): () => void {
  consoleBus.on(CONSOLE_EVENT, listener);
  return () => consoleBus.off(CONSOLE_EVENT, listener);
}
