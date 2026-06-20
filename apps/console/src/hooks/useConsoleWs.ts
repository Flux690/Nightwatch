import { useEffect, useRef } from "react";
import type { ConsoleEvent } from "@nightwatch/shared";

export function useConsoleWs(
  onMessage: (envelope: ConsoleEvent) => void,
): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/console/connect`;
    const ws = new WebSocket(url);

    ws.onmessage = (event: MessageEvent) => {
      try {
        // The wire frame is untyped JSON (it also includes a one-off
        // "connected" ack that isn't part of ConsoleEvent); this is the one
        // place the console trusts the API's shape. Callers switch on `type`
        // and any frame that doesn't match a known case is a no-op for them.
        const envelope = JSON.parse(event.data as string) as ConsoleEvent;
        handlerRef.current(envelope);
      } catch {
        // Ignore malformed frames
      }
    };

    return () => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close();
      } else {
        ws.close();
      }
    };
  }, []);
}
