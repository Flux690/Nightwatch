import { useEffect, useRef } from "react";
import type { ConsoleEvent } from "@nightwatch/shared";

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

// The wire frame is untyped JSON. We own both ends, so a frame is trusted once it
// is an object carrying a string `type` discriminant - enough for callers to
// switch on. Anything else (garbage, a truncated frame, a non-object) is dropped
// here rather than cast straight to ConsoleEvent and handed downstream.
function isConsoleEvent(value: unknown): value is ConsoleEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function useConsoleWs(
  onMessage: (envelope: ConsoleEvent) => void,
): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

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
          if (isConsoleEvent(frame)) handlerRef.current(frame);
        } catch {
          // Ignore malformed (non-JSON) frames.
        }
      };

      ws.onerror = () => ws.close();

      ws.onclose = () => {
        if (disposed) return;
        // Without this, live updates stop after any network blip. Reconnect
        // with capped backoff so a transient drop self-heals.
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
}
