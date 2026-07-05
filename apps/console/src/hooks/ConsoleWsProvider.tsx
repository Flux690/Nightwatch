import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ConsoleEvent } from "@nightwatch/shared";

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

type Subscriber = (envelope: ConsoleEvent) => void;
type Subscribe = (fn: Subscriber) => () => void;

const ConsoleWsContext = createContext<Subscribe | null>(null);

// Untrusted wire JSON: we own both ends, so trust a frame once it is an object with a
// string `type` to switch on; anything else (garbage, truncated) is dropped here.
function isConsoleEvent(value: unknown): value is ConsoleEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

// One shared socket for the whole app: every consumer subscribes through context instead
// of opening its own, so the badge and session view don't race two duplicate connections.
export function ConsoleWsProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const subscribers = useRef(new Set<Subscriber>());

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/console/connect`;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    function connect(): void {
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          // Includes a one-off "connected" ack that isn't a ConsoleEvent case;
          // it passes the guard (it has a string type) and callers no-op on it.
          const frame: unknown = JSON.parse(event.data as string);
          if (isConsoleEvent(frame)) {
            for (const fn of subscribers.current) fn(frame);
          }
        } catch {
          // Ignore malformed (non-JSON) frames.
        }
      };

      ws.onerror = () => ws.close();

      ws.onclose = () => {
        if (disposed) return;
        // Without this, live updates stop after any network blip. Reconnect with
        // capped backoff so a transient drop self-heals.
        const delay =
          RECONNECT_BACKOFF_MS[
            Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
          ]!;
        attempt++;
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.CONNECTING) {
        socket.onopen = () => socket?.close();
      } else {
        socket?.close();
      }
    };
  }, []);

  const subscribe = useRef<Subscribe>((fn) => {
    subscribers.current.add(fn);
    return () => {
      subscribers.current.delete(fn);
    };
  }).current;

  return (
    <ConsoleWsContext.Provider value={subscribe}>
      {children}
    </ConsoleWsContext.Provider>
  );
}

// Subscribe to the shared console event stream for the component's lifetime. A
// no-op when no provider is mounted (e.g. before authentication), so callers need
// no guard of their own.
export function useConsoleWs(onMessage: Subscriber): void {
  const subscribe = useContext(ConsoleWsContext);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((envelope) => handlerRef.current(envelope));
  }, [subscribe]);
}
