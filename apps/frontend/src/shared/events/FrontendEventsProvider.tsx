import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FrontendEvent } from "@nightwarden/shared";

// EventSource retries network drops itself, but a non-200 fails permanently
// (readyState CLOSED); recreate on a fixed cadence so updates never silently die.
const RECREATE_DELAY_MS = 15000;

type Subscriber = (envelope: FrontendEvent) => void;
type Subscribe = (fn: Subscriber) => () => void;

const FrontendEventsContext = createContext<Subscribe | null>(null);

// Untrusted wire JSON: we own both ends, so trust a frame once it is an object with a
// string `type` to switch on; anything else (garbage, truncated) is dropped here.
function isFrontendEvent(value: unknown): value is FrontendEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

// One shared stream for the whole app: every consumer subscribes through context instead
// of opening its own, so the badge and session view don't race two duplicate connections.
export function FrontendEventsProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const subscribers = useRef(new Set<Subscriber>());
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let recreateTimer: ReturnType<typeof setTimeout> | null = null;
    let dropped = false;
    let disposed = false;

    function connect(): void {
      const es = new EventSource("/api/frontend/events");
      source = es;

      es.onopen = () => {
        // Events published during a gap are gone (the feed has no replay), so
        // refetch active queries to catch durable state up after a reconnect.
        if (dropped) {
          dropped = false;
          void queryClient.invalidateQueries();
        }
      };

      es.onmessage = (event: MessageEvent) => {
        try {
          const frame: unknown = JSON.parse(String(event.data));
          if (isFrontendEvent(frame)) {
            for (const fn of subscribers.current) fn(frame);
          }
        } catch {
          // Ignore malformed (non-JSON) frames.
        }
      };

      es.onerror = () => {
        dropped = true;
        // CONNECTING means the browser is retrying on its own; only a CLOSED
        // stream (permanent failure) needs to be recreated by hand.
        if (es.readyState === EventSource.CLOSED && !disposed) {
          recreateTimer = setTimeout(connect, RECREATE_DELAY_MS);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (recreateTimer) clearTimeout(recreateTimer);
      source?.close();
    };
  }, [queryClient]);

  const subscribe = useRef<Subscribe>((fn) => {
    subscribers.current.add(fn);
    return () => {
      subscribers.current.delete(fn);
    };
  }).current;

  return (
    <FrontendEventsContext.Provider value={subscribe}>
      {children}
    </FrontendEventsContext.Provider>
  );
}

// Subscribe to the shared frontend event stream for the component's lifetime;
// a no-op before a provider mounts (e.g. pre-auth), so callers need no guard.
export function useFrontendEvents(onMessage: Subscriber): void {
  const subscribe = useContext(FrontendEventsContext);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((envelope) => handlerRef.current(envelope));
  }, [subscribe]);
}
