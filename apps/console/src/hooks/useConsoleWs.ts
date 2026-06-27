import { useEffect, useRef } from "react";
import type { ConsoleEvent } from "@nightwatch/shared";

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

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
          // The wire frame is untyped JSON (it also includes a one-off
          // "connected" ack that isn't part of ConsoleEvent); this is the one
          // place the console trusts the API's shape. Callers switch on `type`
          // and any frame that doesn't match a known case is a no-op for them.
          const envelope = JSON.parse(event.data as string) as ConsoleEvent;
          handlerRef.current(envelope);
        } catch {
          // Ignore malformed frames.
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
