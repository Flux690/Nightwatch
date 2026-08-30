import { EventEmitter } from "node:events";
import type { FrontendEvent } from "@nightwarden/shared";

// In-process, not Redis: one Node process serves the frontend, so cross-process
// fan-out solves a problem we don't have.
const FRONTEND_EVENT = "frontend-event";

// One listener per open frontend event stream; a single-admin deployment has very few.
// 0 disables Node's leak warning rather than capping at an arbitrary number.
const frontendBus = new EventEmitter();
frontendBus.setMaxListeners(0);

// Best-effort and ephemeral - the durable record is the TranscriptRow
// persisted when the turn completes - so a publish must never throw.
export function publishFrontendEvent(event: FrontendEvent): void {
  frontendBus.emit(FRONTEND_EVENT, event);
}

export function subscribeFrontend(
  listener: (event: FrontendEvent) => void,
): () => void {
  frontendBus.on(FRONTEND_EVENT, listener);
  return () => frontendBus.off(FRONTEND_EVENT, listener);
}
